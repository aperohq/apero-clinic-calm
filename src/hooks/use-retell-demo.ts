import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { DemoCallController, type DemoRequest, type DemoSnapshot } from "@/lib/demo-call";

export const demoRequest: DemoRequest = async (operation, requestId, keepalive = false) => {
  const { data, error } = await supabase.auth.getSession();
  const url = import.meta.env["VITE_SUPABASE_URL"],
    key = import.meta.env["VITE_SUPABASE_PUBLISHABLE_KEY"];
  if (error || !data.session || !url || !key) throw new Error("Demo unavailable");
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
      async () => {
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
          throw new Error("Microphone unavailable");
        return navigator.mediaDevices.getUserMedia({ audio: true });
      },
      (next) => {
        if (mounted) setSnapshot(next);
      },
      (id) => {
        try {
          if (id) sessionStorage.setItem(storageKey, id);
          else sessionStorage.removeItem(storageKey);
        } catch {
          /* Storage is optional. */
        }
      },
    );
    controller.current = current;
    try {
      const id = sessionStorage.getItem(storageKey);
      if (id) void current.recover(id);
    } catch {
      /* Storage is optional. */
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
    start: () => {
      void controller.current?.start();
    },
    stop: () => {
      void controller.current?.stop();
    },
    resumeAudio: () => {
      void controller.current?.resumeAudio();
    },
  };
}
