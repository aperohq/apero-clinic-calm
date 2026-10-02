import assert from "node:assert/strict";
import { after, test } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
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
import { InviteSetupPage } from "@/components/invite-setup-page";
import { LoginPage } from "@/components/clinic-pages";
import { RouteShell } from "@/components/route-shell";

const fixture = globalThis.__authFixture;
let auth: ReturnType<typeof useAuth>;
let root: Root;
let container: HTMLDivElement;
let router: ReturnType<typeof createRouter>;
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function Probe() {
  auth = useAuth();
  return null;
}
async function waitFor(check: () => boolean, label: string) {
  for (let i = 0; i < 180; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    if (check()) return;
  }
  assert.fail(`Timed out: ${label}; page: ${container.textContent}`);
}
async function fill(id: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(id)!;
  assert.ok(input);
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
      input,
      value,
    );
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}
async function submit(password: string, confirm: string) {
  await fill("#setup-password", password);
  await fill("#setup-confirm-password", confirm);
  await act(async () => {
    container
      .querySelector("form")!
      .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  });
}
async function navigate(path: string) {
  await act(async () => {
    await router.navigate({ to: path });
  });
}
after(async () => {
  if (root) await act(async () => root.unmount());
  queryClient.clear();
  await supabase.auth.dispose();
  await globalThis.__cleanupAuthTests();
});

test("invite setup uses actual browser SDK callback initialization and password update", async (t) => {
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
  const routes = [
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/account/setup",
      component: InviteSetupPage,
    }),
    createRoute({ getParentRoute: () => rootRoute, path: "/login", component: LoginPage }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/home",
      component: () => (
        <RouteShell>
          <p>Existing clinic workspace</p>
        </RouteShell>
      ),
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/account",
      component: () => (
        <RouteShell>
          <p>Normal account content</p>
        </RouteShell>
      ),
    }),
  ];
  router = createRouter({
    routeTree: rootRoute.addChildren(routes),
    history: createMemoryHistory({ initialEntries: ["/account/setup"] }),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<RouterProvider router={router} />);
  });

  if (fixture.inviteInvalid) {
    await t.test(
      "expired invite callback yields safe setup state and route back to login",
      async () => {
        await waitFor(() => !auth.loading, "expired invite initialization");
        assert.equal(router.state.location.pathname, "/account/setup");
        assert.equal(auth.session, null);
        assert.match(container.textContent!, /invalid or has expired/);
        assert.ok(!container.querySelector("#setup-password"));
        assert.equal(fixture.passwordUpdates.length, 0);
        assert.ok(container.querySelector('a[href="/login"]'));
      },
    );
    return;
  }
  await t.test("invite session is processed before rejection or login redirect", async () => {
    assert.equal(router.state.location.pathname, "/account/setup");
    assert.match(container.textContent!, /Checking your invitation/);
    assert.ok(!container.querySelector("#login-password"));
    assert.ok(!container.textContent!.includes("invalid or has expired"));
    await waitFor(
      () => !auth.loading && !!container.querySelector("#setup-password"),
      "SDK invite session and clinic initialization",
    );
    fixture.userDelay = 0;
    assert.equal(auth.session?.user.id, fixture.accounts[1].user.id);
    assert.equal(auth.clinic?.id, fixture.accounts[1].clinicId);
    assert.equal(auth.profile?.id, fixture.accounts[1].profileId);
    assert.equal(router.state.location.pathname, "/account/setup");
    assert.ok(
      !window.location.hash.includes("access_token"),
      "SDK removes invite tokens from fragment",
    );
  });
  await t.test("mismatched passwords do not call updateUser", async () => {
    await submit("FirstPassword1", "DifferentPassword1");
    assert.match(container.querySelector('[role="alert"]')!.textContent!, /Passwords do not match/);
    assert.equal(fixture.passwordUpdates.length, 0);
  });
  await t.test("weak passwords do not call updateUser", async () => {
    await submit("short", "short");
    assert.match(container.querySelector('[role="alert"]')!.textContent!, /at least 8 characters/);
    assert.equal(fixture.passwordUpdates.length, 0);
  });
  await t.test(
    "expired password-update session shows a safe error without portal navigation",
    async () => {
      fixture.passwordUpdateError = true;
      await submit("FirstPassword1", "FirstPassword1");
      await waitFor(
        () =>
          !!container.querySelector('[role="alert"]')?.textContent?.includes("Could not create"),
        "password update error",
      );
      assert.equal(router.state.location.pathname, "/account/setup");
      fixture.passwordUpdateError = false;
    },
  );
  await t.test(
    "first password updates only the invited Auth identity and opens its existing workspace",
    async () => {
      const before = fixture.requests.length;
      await submit("FirstPassword1", "FirstPassword1");
      await waitFor(
        () =>
          router.state.location.pathname === "/home" &&
          container.textContent!.includes("Existing clinic workspace"),
        "completed invite enters portal",
      );
      const update = fixture.passwordUpdates.at(-1);
      assert.equal(update.body.password, "FirstPassword1");
      // Supabase adds its own nullable PKCE fields to the password request.
      assert.ok(
        Object.keys(update.body).every((key) =>
          ["password", "code_challenge", "code_challenge_method"].includes(key),
        ),
      );
      assert.equal(update.body.code_challenge, null);
      assert.equal(update.body.code_challenge_method, null);
      assert.equal(update.userId, fixture.accounts[1].user.id);
      assert.equal(auth.clinic?.id, fixture.accounts[1].clinicId);
      assert.equal(auth.profile?.id, fixture.accounts[1].profileId);
      assert.ok(
        !fixture.requests
          .slice(before)
          .some((r) => r.path.startsWith("/rest/") && r.method !== "GET"),
        "password setup never writes profiles or clinic membership",
      );
      const userRequest = fixture.requests
        .slice(before)
        .find((r) => r.path === "/auth/v1/user" && r.method === "PUT");
      assert.ok(userRequest?.authorization?.startsWith("Bearer eyJ"));
    },
  );
  await t.test(
    "sessionless setup visitors receive safe invalid state; normal account login still works",
    async () => {
      await act(async () => {
        await auth.signOut();
      });
      await navigate("/account/setup");
      await waitFor(
        () => !auth.loading && container.textContent!.includes("invalid or has expired"),
        "sessionless setup state",
      );
      assert.equal(router.state.location.pathname, "/account/setup");
      assert.ok(!container.querySelector("#setup-password"));
      await navigate("/account");
      await waitFor(
        () =>
          (router.state.location.pathname === "/login" &&
            !!container.querySelector("#login-password")) ||
          !!container.querySelector('a[href="/login"]'),
        "normal account login",
      );
      if (router.state.location.pathname !== "/login") {
        assert.ok(container.querySelector('a[href="/login"]'));
        await navigate("/login");
        await waitFor(() => !!container.querySelector("#login-password"), "login form");
      }
      await fill("#login-email", fixture.accounts[1].user.email);
      await fill("#login-password", "FirstPassword1");
      await act(async () => {
        container
          .querySelector("form")!
          .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      });
      await waitFor(
        () => router.state.location.pathname === "/home",
        "first password can log in normally",
      );
      assert.equal(auth.clinic?.id, fixture.accounts[1].clinicId);
      await navigate("/account");
      await waitFor(
        () => container.textContent!.includes("Normal account content"),
        "normal authenticated account",
      );
    },
  );
});
