import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { DemoCallController, type DemoRequest, type DemoSnapshot } from "@/lib/demo-call";

export const demoRequest: DemoRequest = async (operation, requestId, keepalive = false) => {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) throw new Error("Sign in required");
  const url = import.meta.env["VITE_SUPABASE_URL"];
  const key = import.meta.env["VITE_SUPABASE_PUBLISHABLE_KEY"];
  if (!url || !key) throw new Error("Demo unavailable");
  return fetch(`${url}/functions/v1/demo-call`, {
    method: "POST",
    keepalive,
    signal: AbortSignal.timeout(45000),
    headers: {
      "Content-Type": "application/json",
      apikey: key,
      Authorization: `Bearer ${data.session.access_token}`,
    },
    body: JSON.stringify({ operation, ...(requestId ? { requestId } : {}) }),
  });
};

export function useRetellDemo() {
  const { session } = useAuth();
  const userId = session?.user.id;
  const [snapshot, setSnapshot] = useState<DemoSnapshot>({
    state: "ready",
    message: "",
    cleanupPending: false,
  });
  const audioLevel = useRef(0);
  const controller = useRef<DemoCallController | null>(null);
  useEffect(() => {
    let mounted = true;
    const storageKey = `apero-demo-pending:${userId}`;
    const current = new DemoCallController(
      demoRequest,
      async (config) => {
        const { RetellClient } = await import("retell-client-js-sdk");
        return new RetellClient(config);
      },
      (next) => {
        if (mounted) setSnapshot(next);
      },
      (samples) => {
        let sum = 0;
        for (const value of samples) sum += value * value;
        audioLevel.current = samples.length ? Math.min(1, Math.sqrt(sum / samples.length) * 5) : 0;
      },
      (id) => {
        try {
          if (id) sessionStorage.setItem(storageKey, id);
          else sessionStorage.removeItem(storageKey);
        } catch {
          /* Storage may be disabled. */
        }
      },
    );
    controller.current = current;
    try {
      const pending = sessionStorage.getItem(storageKey);
      if (pending) void current.recover(pending);
    } catch {
      /* Storage may be disabled. */
    }
    const leave = () => {
      void current.stop();
    };
    window.addEventListener("pagehide", leave);
    return () => {
      mounted = false;
      controller.current = null;
      window.removeEventListener("pagehide", leave);
      void current.stop();
    };
  }, [userId]);
  return {
    ...snapshot,
    audioLevel,
    start: () => {
      void controller.current?.start();
    },
    stop: () => {
      void controller.current?.stop();
    },
    toggleMute: () => controller.current?.mute(),
    resumeAudio: () => {
      void controller.current?.resumeAudio();
    },
  };
}
