import type { RetellClient, RetellClientConfig, WebCallSession } from "retell-client-js-sdk";

export type DemoState =
  "ready" | "permission" | "connecting" | "listening" | "speaking" | "ending" | "ended" | "error";
export type DemoSnapshot = { state: DemoState; message: string; cleanupPending: boolean };
export type DemoRequest = (
  operation: "access" | "create" | "stop",
  requestId?: string,
  keepalive?: boolean,
) => Promise<Response>;

/** Injectable media/provider boundary. Tokens stay in memory and never enter storage or UI. */
export class DemoCallController {
  private session: WebCallSession | undefined;
  private requestId: string | undefined;
  private generation = 0;
  private cleaning: Promise<void> | undefined;
  private silence: ReturnType<typeof setTimeout> | undefined;
  private snapshot: DemoSnapshot = { state: "ready", message: "", cleanupPending: false };
  constructor(
    private request: DemoRequest,
    private client: (config: RetellClientConfig) => Promise<RetellClient>,
    private microphone: () => Promise<MediaStream>,
    private publish: (snapshot: DemoSnapshot) => void,
    private remember: (id: string | undefined) => void = () => undefined,
  ) {}
  private update(patch: Partial<DemoSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.publish(this.snapshot);
  }
  async start() {
    if (
      ["permission", "connecting", "listening", "speaking", "ending"].includes(
        this.snapshot.state,
      ) ||
      this.cleaning ||
      this.snapshot.cleanupPending
    )
      return;
    const generation = ++this.generation;
    this.update({ state: "permission", message: "" });
    try {
      const stream = await this.microphone();
      stream.getTracks().forEach((track) => track.stop());
      if (generation !== this.generation) return;
      this.update({ state: "connecting" });
      const requestId = crypto.randomUUID();
      const sdk = await this.client({
        key: "server-proxy", // SDK transport hook below never forwards this placeholder.
        fetch: async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          if (
            url.origin !== "https://api.retellai.com" ||
            init?.method !== "POST" ||
            url.pathname !== "/v3/create-web-call" ||
            generation !== this.generation
          )
            throw new Error("Demo unavailable");
          this.requestId = requestId;
          this.remember(requestId);
          return this.request("create", requestId);
        },
      });
      if (generation !== this.generation) return;
      this.session = sdk.createWebCall({
        agent_id: "server-selected", // Ignored by the proxy; the private database mapping selects the agent.
        transcript: false,
        audio: { emitRawAudioSamples: true },
        hooks: {
          onStatus: (status) => {
            if (generation === this.generation && status === "live")
              this.update({ state: "listening" });
          },
          onAudio: (samples) => {
            if (
              generation !== this.generation ||
              !["listening", "speaking"].includes(this.snapshot.state)
            )
              return;
            const rms = Math.sqrt(
              samples.reduce((sum, n) => sum + n * n, 0) / (samples.length || 1),
            );
            if (rms > 0.008) {
              if (this.snapshot.state !== "speaking") this.update({ state: "speaking" });
              clearTimeout(this.silence);
              this.silence = setTimeout(() => {
                if (generation === this.generation) this.update({ state: "listening" });
              }, 450);
            }
          },
          onEnd: () => {
            if (generation === this.generation) void this.stop();
          },
          onError: () => {
            if (generation !== this.generation) return;
            this.update({
              state: "error",
              message: "We couldn’t connect. Check your microphone and connection, then try again.",
            });
            void this.stop(true);
          },
        },
      });
      await this.session.ready;
    } catch (error) {
      if (generation !== this.generation) return;
      const name = error instanceof Error ? error.name : "";
      this.update({
        state: "error",
        message:
          name === "NotAllowedError"
            ? "Allow microphone access in your browser settings, then try again."
            : name === "NotFoundError"
              ? "Connect a microphone, then try again."
              : "We couldn’t connect. Check your microphone and connection, then try again.",
      });
      await this.stop(true);
    }
  }
  stop(preserveError = false): Promise<void> {
    if (this.cleaning) return this.cleaning;
    ++this.generation;
    clearTimeout(this.silence);
    const session = this.session,
      requestId = this.requestId;
    this.session = undefined;
    this.update({ state: preserveError ? "error" : "ending" });
    this.cleaning = (async () => {
      try {
        await session?.end();
      } catch {
        /* Server cleanup remains authoritative. */
      }
      try {
        if (requestId) {
          const response = await this.request("stop", requestId, true);
          const result: unknown = response.ok ? await response.json() : null;
          if (
            !result ||
            typeof result !== "object" ||
            !("stopped" in result) ||
            result.stopped !== true
          )
            throw new Error("Cleanup pending");
        }
        this.requestId = undefined;
        this.remember(undefined);
        this.update({
          state: preserveError ? "error" : "ended",
          cleanupPending: false,
          message: preserveError ? this.snapshot.message : "",
        });
      } catch {
        this.update({
          state: "error",
          cleanupPending: true,
          message: "The session is still closing. Retry ending it before starting again.",
        });
      } finally {
        this.cleaning = undefined;
      }
    })();
    return this.cleaning;
  }
  async recover(requestId: string) {
    this.requestId = requestId;
    this.update({ cleanupPending: true });
    await this.stop();
  }
  async resumeAudio() {
    try {
      await this.session?.startAudioPlayback();
    } catch {
      this.update({ message: "Check your speaker settings and try enabling audio again." });
    }
  }
}
