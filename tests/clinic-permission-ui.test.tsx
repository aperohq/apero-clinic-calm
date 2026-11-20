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
import { useAuth } from "@/lib/auth";
import { AuthProvider } from "@/lib/auth-provider";
import { supabase } from "@/integrations/supabase/client";
import { AccountAccessPanel } from "@/components/account-access-panel";
import { RouteShell } from "@/components/route-shell";
import { canAccess, hasPermission } from "@/lib/permissions";

const fixture = globalThis.__authFixture;
let auth: ReturnType<typeof useAuth>;
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } },
});
function Probe() {
  auth = useAuth();
  return null;
}
const rootRoute = createRootRoute({
  component: () => (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Probe />
        <Outlet />
      </AuthProvider>
    </QueryClientProvider>
  ),
});
const routeTree = rootRoute.addChildren(
  ["/account", "/staff", "/home", "/login"].map((path) =>
    createRoute({
      path,
      getParentRoute: () => rootRoute,
      component: () => (
        <RouteShell>
          <p>Permitted clinic content</p>
          <AccountAccessPanel />
        </RouteShell>
      ),
    }),
  ),
);
const router = createRouter({
  routeTree,
  history: createMemoryHistory({ initialEntries: ["/account"] }),
});
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
async function waitFor(check: () => boolean, label: string) {
  for (let n = 0; n < 200; n++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    if (check()) return;
  }
  assert.fail(`Timed out: ${label}`);
}
async function navigate(to: string) {
  await act(async () => {
    await router.navigate({ to });
  });
}
async function refreshRole(role: string) {
  fixture.accounts[0].role = role;
  await act(async () => {
    window.dispatchEvent(new window.Event("focus"));
  });
  await waitFor(() => !auth.loading && auth.role === role, "role refresh");
}
after(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
  await supabase.auth.dispose();
  await globalThis.__cleanupAuthTests();
});

test("role-aware browser authentication and account access", async (t) => {
  await act(async () => {
    root.render(<RouterProvider router={router} />);
  });
  await waitFor(() => !auth.loading, "auth initialization");
  await t.test("sessionless users cannot enter protected content", () => {
    assert.equal(auth.session, null);
    assert.ok(!container.textContent!.includes("Permitted clinic content"));
  });
  await t.test(
    "owner login resolves its clinic and lists only that clinic's accounts",
    async () => {
      await act(async () => {
        assert.equal((await auth.signIn("clinic@example.test", "local-test-password")).error, null);
      });
      await navigate("/account");
      await waitFor(
        () => !auth.loading && !!container.querySelector("select"),
        "owner account controls",
      );
      assert.equal(auth.role, "owner");
      assert.equal(auth.clinicId, "test-clinic");
      assert.ok(!container.textContent!.includes("Clinic B user"));
      assert.ok(!container.querySelector('select[aria-label="Access for Clinic User"]'));
    },
  );
  await t.test(
    "owner assigns only Manager/Staff through the authenticated RPC and verifies saved role",
    async () => {
      const select = container.querySelector<HTMLSelectElement>(
        'select[aria-label="Access for Clinic A second user"]',
      )!;
      assert.deepEqual(
        Array.from(select.options).map((option) => option.value),
        ["staff", "manager"],
      );
      for (const next of ["manager", "staff"]) {
        await act(async () => {
          select.value = next;
          select.dispatchEvent(new window.Event("change", { bubbles: true }));
        });
        await waitFor(
          () => !select.disabled && fixture.roleChanges.at(-1)?.p_role === next,
          "verified role update",
        );
      }
      assert.equal(auth.role, "owner");
      assert.equal(auth.clinicId, "test-clinic");
      const calls = fixture.requests.filter(
        (request) => request.path === "/rest/v1/rpc/set_clinic_member_role",
      );
      assert.equal(calls.length, 2);
      assert.ok(calls.every((request) => request.authorization?.startsWith("Bearer eyJ")));
    },
  );
  await t.test(
    "unchanged-role refresh preserves profile identity and existing form state",
    async () => {
      const previous = auth.profile;
      const select = container.querySelector("select");
      const before = fixture.requests.filter(
        (request) => request.path === "/rest/v1/clinics",
      ).length;
      await act(async () => {
        window.dispatchEvent(new window.Event("focus"));
      });
      await waitFor(
        () =>
          fixture.requests.filter((request) => request.path === "/rest/v1/clinics").length > before,
        "background profile check",
      );
      assert.equal(auth.profile, previous);
      assert.equal(container.querySelector("select"), select);
    },
  );
  await t.test("manager has read-only account access and can enter staff management", async () => {
    queryClient.setQueryData(["owner-only-cache"], { private: true });
    await refreshRole("manager");
    assert.equal(queryClient.getQueryData(["owner-only-cache"]), undefined);
    await waitFor(() => container.textContent!.includes("Only clinic owners"), "manager directory");
    assert.ok(!container.querySelector("select"));
    await navigate("/staff");
    assert.ok(container.textContent!.includes("Permitted clinic content"));
  });
  await t.test("staff cannot see account controls or enter management routes", async () => {
    await refreshRole("staff");
    assert.match(container.textContent!, /isn’t available for your role/);
    assert.ok(!container.querySelector('a[href="/staff"]'));
    assert.ok(!container.querySelector('a[href="/requests"]'));
    await navigate("/account");
    assert.ok(container.textContent!.includes("Permitted clinic content"));
    assert.ok(!container.textContent!.includes("Clinic account access"));
  });
  await t.test("session restoration retains database role; logout blocks content", async () => {
    assert.equal((await supabase.auth.getSession()).data.session?.user.id, auth.session?.user.id);
    await act(async () => {
      await auth.refreshProfile();
    });
    assert.equal(auth.role, "staff");
    await act(async () => {
      assert.equal((await auth.signOut()).error, null);
    });
    await waitFor(() => !auth.session, "logout");
    assert.equal(auth.role, null);
    assert.equal(auth.clinicId, null);
    assert.ok(!container.textContent!.includes("Permitted clinic content"));
  });
});

test("route/action matrix reserves owner-only modules and fails closed", () => {
  for (const role of ["owner", "manager", "staff"] as const) {
    assert.equal(canAccess(role, "/calendar"), true);
    assert.equal(canAccess(role, "/conversations/record"), true);
    assert.equal(canAccess(role, "/staff/person"), role !== "staff");
    assert.equal(canAccess(role, "/account/billing/details"), role === "owner");
    assert.equal(hasPermission(role, "accounts.manage"), role === "owner");
    assert.equal(hasPermission(role, "clinic.configure"), role === "owner");
    assert.equal(hasPermission(role, "analytics.view"), role !== "staff");
    assert.equal(canAccess(role, "/account/unknown-module"), false);
  }
  assert.equal(canAccess(null, "/staff"), false);
});
