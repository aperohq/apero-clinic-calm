import { useEffect, useRef, useState } from "react";
import { db } from "@/lib/db";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";

export function RecordingPlayer({ conversationId }: { conversationId: string }) {
  const { session, clinicId, role } = useAuth();
  const identity = `${session?.user.id ?? ""}:${clinicId ?? ""}:${role ?? ""}:${conversationId}`;
  const [access, setAccess] = useState<{ identity: string; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    setAccess(null);
    setBusy(false);
    setUnavailable(false);
    return () => {
      pending.current?.abort();
      pending.current = null;
    };
  }, [identity]);
  // Signed URL expiry gates new provider requests; it must not unmount an
  // already playing recording. Provider errors return to authorized reload.
  async function load() {
    if (pending.current || !session || !clinicId) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setUnavailable(false);
    try {
      const { data, error } = await db.functions.invoke("recording-access", {
        body: { conversationId },
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (error || typeof data?.url !== "string" || !data.url.startsWith("https://")) {
        setUnavailable(true);
        return;
      }
      setAccess({ identity, url: data.url });
    } catch {
      if (!controller.signal.aborted) setUnavailable(true);
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  }
  return access?.identity === identity ? (
    <audio
      controls
      preload="none"
      src={access.url}
      className="w-full min-w-0 sm:flex-1"
      aria-label="Call recording"
      onError={() => {
        setAccess(null);
        setUnavailable(true);
      }}
    />
  ) : (
    <div className="flex flex-1 flex-wrap items-center gap-2">
      {unavailable && (
        <span role="status" className="text-sm text-muted-foreground">
          Recording unavailable.
        </span>
      )}
      <Button
        variant="outline"
        disabled={busy || !session || !clinicId}
        onClick={() => void load()}
      >
        {busy ? "Loading recording…" : unavailable ? "Try again" : "Load recording"}
      </Button>
    </div>
  );
}
