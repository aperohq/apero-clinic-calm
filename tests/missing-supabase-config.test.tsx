import assert from "node:assert/strict";
import { after, test } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { AuthProvider } from "@/lib/auth-provider";
import { hasSupabaseConfiguration } from "@/integrations/supabase/client";

test("missing frontend Supabase settings fail closed without mounting authenticated content or crashing", async () => {
  assert.equal(hasSupabaseConfiguration, false);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let protectedMounts = 0;
  let remoteRequests = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { remoteRequests++; throw new Error("Unexpected request without configuration"); };
  function ProtectedContent() { protectedMounts++; return null; }
  try {
    await act(async () => { root.render(<AuthProvider><ProtectedContent /></AuthProvider>); });
    assert.equal(protectedMounts, 0);
    assert.equal(remoteRequests, 0);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
  }
});
after(async () => { await globalThis.__cleanupAuthTests(); });