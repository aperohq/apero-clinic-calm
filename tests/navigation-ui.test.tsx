import assert from "node:assert/strict";
import { after, test } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { AuthProvider, useAuth } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { AppLayout } from "@/components/app-layout";
import { AccountPage } from "@/components/clinic-pages";

const fixture = globalThis.__authFixture;
let auth: ReturnType<typeof useAuth>;
const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
function Probe() {
  auth = useAuth();
  return null;
}
const parent = createRootRoute({
  component: () => (
    <QueryClientProvider client={client}>
      <AuthProvider>
        <Probe />
        <AppLayout>
          <Outlet />
        </AppLayout>
      </AuthProvider>
    </QueryClientProvider>
  ),
});
const router = createRouter({
  routeTree: parent.addChildren(
    ["/account", "/account/settings", "/calendar", "/support", "/privacy", "/terms"].map((path) =>
      createRoute({
        path,
        getParentRoute: () => parent,
        component: path === "/account" ? AccountPage : () => <p>Existing destination</p>,
      }),
    ),
  ),
  history: createMemoryHistory({ initialEntries: ["/account"] }),
});
const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
async function waitFor(check: () => boolean) {
  for (let n = 0; n < 200; n++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    if (check()) return;
  }
  assert.fail("Navigation did not settle");
}
const expected = {
  owner: [
    "Home",
    "Calendar",
    "Clients",
    "Staff",
    "Team",
    "Conversations",
    "Requests",
    "Analytics",
    "Support",
    "Account",
  ],
  manager: [
    "Home",
    "Calendar",
    "Clients",
    "Staff",
    "Conversations",
    "Requests",
    "Analytics",
    "Support",
    "Account",
  ],
  staff: ["Home", "Calendar", "Clients", "Conversations", "Support", "Account"],
};
function checkNav(nav: Element, role: keyof typeof expected, compact = false) {
  const links = Array.from(nav.querySelectorAll("a"));
  assert.deepEqual(
    links.map((link) => (compact ? link.getAttribute("title") : link.textContent)),
    expected[role],
  );
  assert.equal(nav.querySelector('a[href="/account/settings"]'), null);
  assert.equal(nav.querySelector('a[aria-current="page"]')?.getAttribute("href"), "/account");
  const utilities = nav.lastElementChild!;
  assert.deepEqual(
    Array.from(utilities.querySelectorAll("a")).map((link) => link.getAttribute("href")),
    ["/support", "/account"],
  );
  assert.ok(utilities.querySelector('button[aria-label="Log out"]'));
}
after(async () => {
  await act(async () => root.unmount());
  client.clear();
  await supabase.auth.dispose();
  await globalThis.__cleanupAuthTests();
});
test("dashboard navigation and Account settings access preserve role restrictions", async (t) => {
  await act(async () => {
    root.render(<RouterProvider router={router} />);
  });
  await waitFor(() => !auth.loading);
  await act(async () => {
    assert.equal((await auth.signIn("clinic@example.test", "local-test-password")).error, null);
  });
  await waitFor(() => auth.role === "owner");
  for (const role of ["owner", "manager", "staff"] as const) {
    await t.test(
      `${role}: expanded, collapsed, mobile navigation and Account actions`,
      async () => {
        fixture.accounts[0].role = role;
        await act(async () => {
          window.dispatchEvent(new window.Event("focus"));
        });
        await waitFor(() => !auth.loading && auth.role === role);
        checkNav(host.querySelector('nav[aria-label="Dashboard"]')!, role);
        const help = Array.from(host.querySelectorAll("h2, h3"))
          .find((node) => node.textContent === "Need help?")!
          .closest("section")!;
        assert.ok(help.querySelector('a[href="/support"]'));
        assert.ok(help.querySelector('a[href="/privacy"]'));
        assert.ok(help.querySelector('a[href="/terms"]'));
        assert.equal(!!help.querySelector('a[href="/account/settings"]'), role === "owner");
        if (role === "owner") {
          await act(async () => {
            (help.querySelector('a[href="/account/settings"]') as HTMLElement).click();
          });
          await waitFor(() => router.state.location.pathname === "/account/settings");
          await act(async () => {
            await router.navigate({ to: "/account" });
          });
        }
        await act(async () => {
          (host.querySelector('button[aria-label="Collapse sidebar"]') as HTMLElement).click();
        });
        checkNav(host.querySelector('nav[aria-label="Dashboard"]')!, role, true);
        await act(async () => {
          (host.querySelector('button[aria-label="Expand sidebar"]') as HTMLElement).click();
        });
        await act(async () => {
          (host.querySelector('button[aria-label="Open menu"]') as HTMLElement).click();
        });
        const mobile = host.querySelector('aside[aria-label="Clinic navigation"]')!;
        checkNav(mobile.querySelector("nav")!, role);
        await act(async () => {
          (mobile.querySelector('a[href="/calendar"]') as HTMLElement).click();
        });
        await waitFor(
          () =>
            router.state.location.pathname === "/calendar" &&
            !host.querySelector('aside[aria-label="Clinic navigation"]'),
        );
        assert.equal(
          host.querySelector('nav a[aria-current="page"]')?.getAttribute("href"),
          "/calendar",
        );
        await act(async () => {
          await router.navigate({ to: "/account" });
        });
      },
    );
  }
});
