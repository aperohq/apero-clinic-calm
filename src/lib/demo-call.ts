import type { RetellClient, RetellClientConfig, WebCallSession } from "retell-client-js-sdk";
export type DemoState = "ready" | "connecting" | "active" | "muted" | "ended" | "error";
export type DemoSnapshot = { state: DemoState; message: string; cleanupPending: boolean };
export type DemoRequest = (
  operation: "access" | "create" | "stop",
  requestId?: string,
  keepalive?: boolean,
) => Promise<Response>;
export const DEMO_CLINIC_REFERENCE = "11111111-1111-4111-8111-111111111111";
const AGENT = "agent_b84b2766efeb85afc809147d7a";

// Injectable boundary for local lifecycle tests. Never stores call access tokens.
export class DemoCallController {
  private session: WebCallSession | undefined;
  private requestId: string | undefined;
  private generation = 0;
  private creating = false;
  private cleaning: Promise<void> | undefined;
  private snapshot: DemoSnapshot = { state: "ready", message: "", cleanupPending: false };
  constructor(
    private request: DemoRequest,
    private client: (config: RetellClientConfig) => Promise<RetellClient>,
    private publish: (snapshot: DemoSnapshot) => void,
    private audio: (samples: Float32Array) => void,
    private remember: (id: string | undefined) => void = () => undefined,
  ) {}
  private update(patch: Partial<DemoSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.publish(this.snapshot);
  }
  async start() {
    if (
      ["connecting", "active", "muted"].includes(this.snapshot.state) ||
      this.cleaning ||
      this.snapshot.cleanupPending
    )
      return;
    const generation = ++this.generation;
    const requestId = crypto.randomUUID();
    this.requestId = requestId;
    this.update({ state: "connecting", message: "", cleanupPending: false });
    try {
      const sdk = await this.client({
        key: "unused", // The authenticated proxy supplies the private provider key.
        fetch: async (input, init) => {
          const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
          if (init?.method !== "POST") throw new Error("Unsupported demo operation");
          if (path === "/v3/create-web-call") {
            if (generation !== this.generation) throw new Error("Call cancelled");
            this.creating = true;
            this.remember(requestId);
            // The SDK body/headers are deliberately not forwarded; the server owns agent/version selection.
            return this.request("create", requestId);
          }
          if (/^\/v2\/stop-call\/[a-zA-Z0-9_-]+$/.test(path))
            return this.request("stop", requestId, true);
          throw new Error("Unsupported demo operation");
        },
      });
      if (generation !== this.generation) return;
      const session = sdk.createWebCall({
        agent_id: AGENT,
        transcript: false,
        audio: { emitRawAudioSamples: true },
        hooks: {
          onStatus: (status) => {
            if (generation !== this.generation) return;
            if (status === "live") this.update({ state: "active" });
          },
          onAudio: (samples) => {
            if (generation === this.generation) this.audio(samples);
          },
          onEnd: () => {
            if (generation === this.generation) void this.stop();
          },
          onError: (error) => {
            if (generation !== this.generation) return;
            this.update({
              state: "error",
              message:
                error.name === "NotAllowedError" || /permission|denied/i.test(error.message)
                  ? "Microphone access was denied. Allow microphone access in your browser, then retry."
                  : "The voice connection failed. Check your connection and demo access, then retry.",
            });
            void this.stop(true);
          },
        },
      });
      this.session = session;
      await session.ready.catch(() => undefined); // onError owns sanitized UI messages.
    } catch {
      if (generation !== this.generation) return;
      this.update({
        state: "error",
        message: "Could not start the call. Check your connection and demo access, then retry.",
      });
      await this.stop(true);
    }
  }
  async resumeAudio() {
    try {
      await this.session?.startAudioPlayback();
    } catch {
      this.update({
        message: "Speaker playback could not start. Check your browser audio settings.",
      });
    }
  }
  mute() {
    if (this.snapshot.state === "active") {
      this.session?.mute();
      this.update({ state: "muted" });
    } else if (this.snapshot.state === "muted") {
      this.session?.unmute();
      this.update({ state: "active" });
    }
  }
  stop(preserveError = false): Promise<void> {
    if (this.cleaning) return this.cleaning;
    ++this.generation;
    const recovering = this.snapshot.cleanupPending;
    const session = this.session,
      requestId = this.requestId,
      creating = this.creating;
    this.session = undefined;
    this.audio(new Float32Array());
    this.update({ state: preserveError ? "error" : "ended", cleanupPending: creating });
    // Defer so reentrant SDK onEnd callbacks see the cleanup promise.
    this.cleaning = Promise.resolve()
      .then(async () => {
        try {
          await session?.end();
        } catch {
          /* Server cleanup still runs. */
        }
        if (!requestId || !creating) return;
        try {
          const result = await this.request("stop", requestId, true);
          if (!result.ok) throw new Error("Cleanup pending");
          this.creating = false;
          this.requestId = undefined;
          this.remember(undefined);
          this.update(
            recovering
              ? { state: "ready", cleanupPending: false, message: "" }
              : { cleanupPending: false, message: preserveError ? this.snapshot.message : "" },
          );
        } catch {
          this.update({
            cleanupPending: true,
            message:
              "Audio has ended. Server cleanup is pending; retry cleanup before starting another call.",
          });
        }
      })
      .finally(() => {
        this.cleaning = undefined;
      });
    return this.cleaning;
  }
  async recover(requestId: string) {
    this.requestId = requestId;
    this.creating = true;
    this.update({ cleanupPending: true });
    await this.stop();
  }
}
