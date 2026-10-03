import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createClient } from "@supabase/supabase-js";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { AuthProvider, useAuth } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { RouteShell } from "@/components/route-shell";
import { LoginPage } from "@/components/clinic-pages";
import { AccountAccessPanel } from "@/components/account-access-panel";
import {
  useClients,
  useStaff,
  useAppointments,
  useConversations,
  useAvailability,
  useClientNotes,
  useTimeOff,
} from "@/lib/apero-store";
import { useVoiceRequests } from "@/lib/voice-requests";

const fixture = globalThis.__authFixture;
let auth: ReturnType<typeof useAuth>;
let root: Root;
let container: HTMLDivElement;
let router: ReturnType<typeof createRouter>;
let queryClient: QueryClient;
let portalMounts = 0;
const accountSnapshots: {
  clinicId: string | null;
  profileClinicId: string | null;
  clinicRowId: string | null;
}[] = [];
function Probe() {
  auth = useAuth();
  // Mount data hooks outside the route guard to verify they independently wait
  // for a validated clinic, rather than depending only on hidden portal UI.
  useClients();
  useStaff();
  useAppointments();
  useConversations();
  useAvailability("test-staff");
  useTimeOff("test-staff");
  useClientNotes("test-client");
  useVoiceRequests();
  useEffect(() => {
    accountSnapshots.push({
      clinicId: auth.clinicId,
      profileClinicId: auth.profile?.clinic_id ?? null,
      clinicRowId: auth.clinic?.id ?? null,
    });
  });
  return null;
}
function PortalPage() {
  useEffect(() => {
    portalMounts++;
  }, []);
  return (
    <>
      <p>Protected clinic content</p>
      <AccountAccessPanel />
    </>
  );
}
async function waitFor(check: () => boolean, label: string) {
  for (let attempt = 0; attempt < 150; attempt++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    if (check()) return;
  }
  assert.fail(`Timed out: ${label}. Current page: ${container?.textContent}`);
}
async function mount(path: string) {
  if (root) {
    await act(async () => root.unmount());
    container.remove();
    queryClient.clear();
  }
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { gcTime: Infinity },
    },
  });
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
    createRoute({ getParentRoute: () => rootRoute, path: "/login", component: LoginPage }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <Navigate to="/home" replace />,
    }),
    ...[
      "/home",
      "/calendar",
      "/clients",
      "/clients/$id",
      "/staff",
      "/staff/$id",
      "/conversations",
      "/conversations/$id",
      "/requests",
      "/support",
      "/account",
    ].map((path) =>
      createRoute({
        getParentRoute: () => rootRoute,
        path,
        component: () => (
          <RouteShell>
            <PortalPage />
          </RouteShell>
        ),
      }),
    ),
  ];
  router = createRouter({
    routeTree: rootRoute.addChildren(routes),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<RouterProvider router={router} />);
  });
  await waitFor(() => auth && !auth.loading, "auth initialization");
}
async function navigate(path: string) {
  await act(async () => {
    await router.navigate({ to: path });
  });
}
async function fill(id: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(id)!;
  assert.ok(input, `Input ${id} exists`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
      input,
      value,
    );
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}
async function submit(password: string) {
  await fill("#login-email", "clinic@example.test");
  await fill("#login-password", password);
  await act(async () => {
    container
      .querySelector("form")!
      .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  });
}
async function clickLogout() {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === "Log out",
  );
  assert.ok(button, "Logout is available");
  await act(async () => button.click());
}
after(async () => {
  if (root) await act(async () => root.unmount());
  queryClient?.clear();
  await supabase.auth.dispose();
  await globalThis.__cleanupAuthTests();
});

test("clinic authentication with the real Supabase SDK and local HTTP fixtures", async (t) => {
  await t.test(
    "unauthenticated portal and nested routes redirect without rendering clinic content",
    async () => {
      await mount("/home");
      for (const path of [
        "/home",
        "/calendar",
        "/clients",
        "/clients/example",
        "/staff",
        "/staff/example",
        "/conversations",
        "/conversations/example",
        "/requests",
        "/support",
        "/account",
      ]) {
        await navigate(path);
        await waitFor(() => router.state.location.pathname === "/login", `redirect ${path}`);
        assert.ok(!container.textContent?.includes("Protected clinic content"));
      }
      assert.equal(fixture.requests.filter((r) => r.path.startsWith("/rest/")).length, 0);
    },
  );
  await t.test("invalid credentials show a useful accessible error", async () => {
    await submit("incorrect-password");
    await waitFor(() => !!container.querySelector('[role="alert"]'), "invalid password error");
    assert.equal(
      container.querySelector('[role="alert"]')!.textContent,
      "Incorrect email or password.",
    );
    assert.equal(auth.session, null);
    assert.equal(router.state.location.pathname, "/login");
  });
  await t.test("valid credentials log in and attach the user token to profile reads", async () => {
    await submit("local-test-password");
    await waitFor(
      () => container.textContent!.includes("Protected clinic content"),
      "successful login",
    );
    assert.equal(router.state.location.pathname, "/home");
    assert.ok(auth.session);
    assert.equal(auth.clinic?.name, "Test Clinic");
    assert.equal(auth.clinicId, "test-clinic");
    assert.equal(auth.profile?.clinic_id, auth.clinicId);
    assert.equal(auth.session?.user.user_metadata.clinic_id, "untrusted-clinic");
    assert.equal(
      fixture.requests.find((r) => r.path === "/rest/v1/profiles")?.search.auth_user_id,
      `eq.${auth.session!.user.id}`,
    );
    assert.equal(
      fixture.requests.find((r) => r.path === "/rest/v1/clinics")?.search.id,
      "eq.test-clinic",
    );
    assert.ok(
      fixture.requests
        .find((r) => r.path === "/rest/v1/profiles")
        ?.authorization?.startsWith("Bearer eyJ"),
    );
    assert.ok(Object.keys(localStorage).length || localStorage.length, "SDK persisted a session");
  });
  await t.test("authenticated users can access every portal route", async () => {
    for (const path of [
      "/calendar",
      "/clients",
      "/staff",
      "/conversations",
      "/requests",
      "/support",
      "/account",
    ]) {
      await navigate(path);
      await waitFor(
        () => container.textContent!.includes("Protected clinic content"),
        `access ${path}`,
      );
      assert.equal(router.state.location.pathname, path);
    }
  });
  await t.test(
    "session persists through provider remount and a fresh SDK storage read",
    async () => {
      const passwordRequests = fixture.requests.filter((r) => r.grant === "password").length;
      await mount("/calendar");
      await waitFor(
        () => container.textContent!.includes("Protected clinic content"),
        "restored session",
      );
      assert.equal(router.state.location.pathname, "/calendar");
      assert.equal(auth.clinicId, "test-clinic");
      assert.equal(auth.profile?.clinic_id, auth.clinic?.id);
      const { createClient } = await import("@supabase/supabase-js");
      const restoredClient = createClient(
        import.meta.env.VITE_SUPABASE_URL,
        import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        {
          auth: {
            storage: localStorage,
            persistSession: true,
            autoRefreshToken: false,
            detectSessionInUrl: false,
          },
        },
      );
      const { data, error } = await restoredClient.auth.getSession();
      assert.equal(error, null);
      assert.equal(data.session?.user.id, auth.session?.user.id);
      await restoredClient.auth.dispose();
      assert.equal(fixture.requests.filter((r) => r.grant === "password").length, passwordRequests);
    },
  );
  await t.test("logged-in users visiting login or root go directly to home", async () => {
    await navigate("/login");
    await waitFor(() => router.state.location.pathname === "/home", "skip login");
    assert.ok(!container.querySelector("#login-password"));
    await navigate("/");
    await waitFor(() => router.state.location.pathname === "/home", "root redirect");
  });
  await t.test(
    "token refresh keeps the workspace mounted without reloading the profile",
    async () => {
      const mounts = portalMounts;
      const reads = fixture.requests.filter((r) => r.path === "/rest/v1/profiles").length;
      const previousToken = auth.session!.access_token;
      await act(async () => {
        const { error } = await supabase.auth.refreshSession();
        assert.equal(error, null);
      });
      assert.notEqual(auth.session!.access_token, previousToken);
      assert.equal(auth.loading, false);
      assert.equal(portalMounts, mounts);
      assert.equal(fixture.requests.filter((r) => r.path === "/rest/v1/profiles").length, reads);
    },
  );
  await t.test(
    "workspace queries and cache keys use the resolved clinic, ignoring frontend clinic input",
    async () => {
      localStorage.setItem("apero-clinic-id", "second-clinic");
      await act(async () => {
        await router.navigate({ to: "/home", search: { clinic_id: "second-clinic" } });
      });
      const keys = [
        "clients",
        "staff",
        "appointments",
        "conversations",
        "availability",
        "time_off",
        "client_notes",
        "voice_requests",
      ];
      await waitFor(
        () =>
          keys.every(
            (key) =>
              queryClient.getQueryState([
                key,
                "test-clinic",
                ...(["availability", "time_off"].includes(key)
                  ? ["test-staff"]
                  : key === "client_notes"
                    ? ["test-client"]
                    : []),
              ])?.status === "success",
          ),
        "clinic data loaded",
      );
      const reads = fixture.requests.filter(
        (r) =>
          r.path.startsWith("/rest/v1/") &&
          !["/rest/v1/profiles", "/rest/v1/clinics", "/rest/v1/rpc/clinic_team_members"].includes(r.path),
      );
      assert.ok(reads.length >= keys.length);
      assert.ok(reads.every((r) => r.search.clinic_id === "eq.test-clinic"));
      assert.equal(auth.clinicId, "test-clinic");
      assert.deepEqual(
        queryClient
          .getQueryData<{ clinic_id: string }[]>(["clients", "test-clinic"])
          ?.map((row) => row.clinic_id),
        ["test-clinic"],
      );
      localStorage.removeItem("apero-clinic-id");
    },
  );
  await t.test(
    "owner assigns Manager/Staff access through verified RPC without changing ownership",
    async () => {
      await waitFor(
        () => !!container.querySelector('select[aria-label="Access for Clinic A second user"]'),
        "owner access controls",
      );
      assert.ok(!container.querySelector('select[aria-label="Access for Clinic User"]'));
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
          () =>
            select.value === next &&
            !select.disabled &&
            fixture.roleChanges.at(-1)?.p_role === next,
          "verified role update",
        );
      }
      assert.equal(auth.role, "owner");
      assert.equal(auth.clinicId, "test-clinic");
      assert.ok(!container.textContent!.includes("Clinic B user"));
    },
  );
  await t.test("unchanged-role focus refresh preserves the mounted portal", async () => {
    const mounts = portalMounts;
    const profile = auth.profile;
    const reads = fixture.requests.filter((request) => request.path === "/rest/v1/profiles").length;
    await act(async () => { window.dispatchEvent(new window.Event("focus")); });
    await waitFor(() => fixture.requests.filter((request) => request.path === "/rest/v1/profiles").length > reads, "background permission check");
    assert.equal(auth.loading, false);
    assert.equal(portalMounts, mounts);
    assert.equal(auth.profile, profile);
  });
  await t.test(
    "focus refresh applies changed roles, clears privileged cache, and blocks Staff routes/actions",
    async () => {
      for (const next of ["manager", "staff", "owner"]) {
        queryClient.setQueryData(["privileged-fixture"], { sensitive: true });
        fixture.accounts[0].role = next;
        await act(async () => {
          window.dispatchEvent(new window.Event("focus"));
        });
        await waitFor(() => !auth.loading && auth.role === next, "updated database role");
        assert.equal(queryClient.getQueryData(["privileged-fixture"]), undefined);
        await act(async () => {
          await router.navigate({ to: "/staff" });
        });
        if (next === "staff") {
          assert.match(container.textContent!, /isn’t available for your role/);
          assert.ok(!container.querySelector('a[href="/staff"]'));
          assert.ok(!container.querySelector('a[href="/requests"]'));
          await act(async () => {
            await router.navigate({ to: "/account" });
          });
          assert.ok(!container.textContent!.includes("Clinic account access"));
        } else {
          await waitFor(
            () => container.textContent!.includes("Clinic account access"),
            "account directory",
          );
          assert.equal(
            !!container.querySelector('select[aria-label="Access for Clinic A second user"]'),
            next === "owner",
          );
        }
      }
      await act(async () => {
        await router.navigate({ to: "/home" });
      });
    },
  );
  await t.test("logout clears session and clinic cache and redirects to login", async () => {
    queryClient.setQueryData(["test-clinic-data"], { private: true });
    await clickLogout();
    await waitFor(() => router.state.location.pathname === "/login", "logout redirect");
    assert.equal(auth.session, null);
    assert.equal(auth.profile, null);
    assert.equal(auth.clinic, null);
    assert.equal(auth.clinicId, null);
    assert.equal(queryClient.getQueryData(["test-clinic-data"]), undefined);
    assert.equal((await supabase.auth.getSession()).data.session, null);
    assert.equal(localStorage.length, 0);
    await mount("/home");
    await waitFor(() => router.state.location.pathname === "/login", "logged out after refresh");
  });
  await t.test("missing clinic profile blocks portal content and still allows logout", async () => {
    fixture.missingProfile = true;
    await submit("local-test-password");
    await waitFor(() => container.textContent!.includes("No clinic is linked"), "unlinked account");
    assert.ok(!container.textContent!.includes("Protected clinic content"));
    await clickLogout();
    await waitFor(() => router.state.location.pathname === "/login", "unlinked account logout");
    fixture.missingProfile = false;
  });
  await t.test(
    "logout honors the cleared local session even when remote revocation fails",
    async () => {
      await submit("local-test-password");
      await waitFor(
        () => container.textContent!.includes("Protected clinic content"),
        "login before revocation failure",
      );
      fixture.logoutError = true;
      await act(async () => {
        assert.equal((await auth.signOut()).error, null);
      });
      assert.equal(auth.session, null);
      assert.equal((await supabase.auth.getSession()).data.session, null);
      await waitFor(
        () => router.state.location.pathname === "/login",
        "local logout after revocation failure",
      );
      fixture.logoutError = false;
    },
  );
  await t.test("profile errors block portal content and still allow logout", async () => {
    fixture.profileError = true;
    await submit("local-test-password");
    await waitFor(
      () => container.textContent!.includes("We couldn’t load your account"),
      "profile error",
    );
    assert.ok(!container.textContent!.includes("Protected clinic content"));
    await clickLogout();
    await waitFor(() => router.state.location.pathname === "/login", "profile error logout");
    fixture.profileError = false;
  });
  await t.test("a delayed profile response cannot restore data after logout", async () => {
    fixture.profileDelay = 200;
    await act(async () => {
      assert.equal((await auth.signIn("clinic@example.test", "local-test-password")).error, null);
    });
    await waitFor(() => !!auth.session && auth.loading, "profile load in progress");
    await act(async () => {
      assert.equal((await auth.signOut()).error, null);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    assert.equal(auth.session, null);
    assert.equal(auth.profile, null);
    assert.equal(auth.clinic, null);
    assert.equal(auth.loading, false);
    fixture.profileDelay = 0;
  });
  const workspaceReads = () =>
    fixture.requests.filter(
      (r) =>
        r.path.startsWith("/rest/v1/") &&
        !["/rest/v1/profiles", "/rest/v1/clinics", "/rest/v1/rpc/clinic_team_members"].includes(r.path),
    ).length;
  for (const [label, changes, message] of [
    ["profile has no clinic ID", { profileClinicId: null }, "No clinic is linked"],
    ["profile has an empty clinic ID", { profileClinicId: "" }, "No clinic is linked"],
    ["clinic row is missing or inaccessible", { missingClinic: true }, "No clinic is linked"],
    ["clinic row does not match profile", { mismatchedClinic: true }, "No clinic is linked"],
    [
      "profile belongs to another authenticated user",
      { mismatchedUser: true },
      "No clinic is linked",
    ],
    ["clinic read fails", { clinicError: true }, "We couldn’t load your account"],
  ] as const) {
    await t.test(`${label} blocks portal and data loading after login and restore`, async () => {
      Object.assign(fixture, changes);
      const reads = workspaceReads();
      await submit("local-test-password");
      await waitFor(() => container.textContent!.includes(message), label);
      assert.ok(auth.session);
      assert.equal(auth.clinicId, null);
      assert.equal(auth.profile, null);
      assert.equal(auth.clinic, null);
      assert.ok(!container.textContent!.includes("Protected clinic content"));
      assert.equal(workspaceReads(), reads);
      await mount("/calendar");
      await waitFor(() => container.textContent!.includes(message), `restore ${label}`);
      assert.equal(workspaceReads(), reads);
      await clickLogout();
      await waitFor(() => router.state.location.pathname === "/login", `logout ${label}`);
      Object.assign(fixture, {
        profileClinicId: "test-clinic",
        missingClinic: false,
        mismatchedClinic: false,
        mismatchedUser: false,
        clinicError: false,
      });
    });
  }
  await t.test(
    "profile and clinic are published together after delayed clinic resolution",
    async () => {
      fixture.clinicDelay = 200;
      const reads = workspaceReads();
      await act(async () => {
        assert.equal((await auth.signIn("clinic@example.test", "local-test-password")).error, null);
      });
      await waitFor(() => !!auth.session && auth.loading, "clinic resolution pending");
      assert.equal(auth.profile, null);
      assert.equal(auth.clinic, null);
      assert.equal(auth.clinicId, null);
      assert.equal(workspaceReads(), reads);
      await waitFor(() => auth.clinicId === "test-clinic", "clinic resolved");
      assert.equal(auth.profile?.clinic_id, auth.clinic?.id);
      fixture.clinicDelay = 0;
    },
  );
  await t.test(
    "re-resolving a changed database association clears previous clinic data",
    async () => {
      queryClient.setQueryData(["private-test-data", "test-clinic"], { cached: true });
      fixture.profileClinicId = "second-clinic";
      await act(async () => {
        await auth.refreshProfile();
      });
      assert.equal(auth.clinicId, "second-clinic");
      assert.equal(auth.profile?.clinic_id, "second-clinic");
      assert.equal(queryClient.getQueryData(["private-test-data", "test-clinic"]), undefined);
      assert.equal(queryClient.getQueryData(["clients", "test-clinic"]), undefined);
      await waitFor(
        () => queryClient.getQueryState(["clients", "second-clinic"])?.status === "success",
        "new clinic data loaded",
      );
      assert.deepEqual(
        queryClient
          .getQueryData<{ clinic_id: string }[]>(["clients", "second-clinic"])
          ?.map((row) => row.clinic_id),
        ["second-clinic"],
      );
      await mount("/calendar");
      assert.equal(auth.clinicId, "second-clinic");
      await clickLogout();
      await waitFor(() => router.state.location.pathname === "/login", "changed clinic logout");
      assert.equal(auth.clinicId, null);
      fixture.profileClinicId = "test-clinic";
    },
  );
  await t.test(
    "a revoked association blocks an existing session and clears its cached data",
    async () => {
      await submit("local-test-password");
      await waitFor(() => auth.clinicId === "test-clinic", "login before revoked association");
      queryClient.setQueryData(["private-test-data", "test-clinic"], { cached: true });
      fixture.missingClinic = true;
      await act(async () => {
        await auth.refreshProfile();
      });
      assert.equal(auth.clinicId, null);
      assert.equal(auth.profile, null);
      assert.equal(auth.clinic, null);
      assert.equal(queryClient.getQueryData(["private-test-data", "test-clinic"]), undefined);
      await waitFor(
        () => container.textContent!.includes("No clinic is linked"),
        "revoked association blocked",
      );
      fixture.missingClinic = false;
      await act(async () => {
        await auth.refreshProfile();
      });
      assert.equal(auth.clinicId, "test-clinic");
      await clickLogout();
      await waitFor(() => router.state.location.pathname === "/login", "resolved account logout");
    },
  );
  await t.test("a late clinic response cannot restore association after logout", async () => {
    fixture.clinicDelay = 200;
    const clinicReads = fixture.requests.filter((r) => r.path === "/rest/v1/clinics").length;
    await act(async () => {
      await auth.signIn("clinic@example.test", "local-test-password");
    });
    await waitFor(
      () => fixture.requests.filter((r) => r.path === "/rest/v1/clinics").length > clinicReads,
      "clinic read started",
    );
    await act(async () => {
      await auth.signOut();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    assert.equal(auth.clinicId, null);
    assert.equal(auth.profile, null);
    assert.equal(auth.clinic, null);
    assert.equal(auth.loading, false);
    assert.equal(auth.session, null);
    fixture.clinicDelay = 0;
    assert.ok(
      accountSnapshots.every(
        (snapshot) =>
          snapshot.clinicId === snapshot.profileClinicId &&
          snapshot.clinicId === snapshot.clinicRowId,
      ),
      "every rendered clinic context is consistent",
    );
  });
  await t.test(
    "A1 and A2 resolve to shared Clinic A; B1 restores its separate workspace",
    async () => {
      for (const account of fixture.accounts) {
        await act(async () => {
          const result = await auth.signIn(account.user.email, "local-test-password");
          assert.equal(result.error, null);
        });
        await waitFor(
          () => !auth.loading && auth.profile?.auth_user_id === account.user.id,
          `membership for ${account.user.email}`,
        );
        assert.equal(auth.clinicId, account.clinicId);
        assert.equal(auth.profile?.id, account.profileId);
        assert.equal(auth.profile?.full_name, account.fullName);
        assert.equal(auth.profile?.email, account.user.email);
        await waitFor(
          () => queryClient.getQueryState(["clients", account.clinicId])?.status === "success",
          "shared workspace data",
        );
        assert.deepEqual(
          queryClient
            .getQueryData<{ clinic_id: string }[]>(["clients", account.clinicId])
            ?.map((row) => row.clinic_id),
          [account.clinicId],
        );
        await act(async () => {
          const result = await supabase.auth.refreshSession();
          assert.equal(result.error, null);
        });
        await mount("/home");
        assert.equal(auth.session?.user.id, account.user.id);
        assert.equal(auth.clinicId, account.clinicId);
        await act(async () => assert.equal((await auth.signOut()).error, null));
        await waitFor(() => auth.session === null, "individual logout");
        assert.equal(auth.clinicId, null);
        assert.equal(auth.profile, null);
      }
    },
  );
  await t.test("independent browsers retain A2/B1 sessions when A1 logs out", async () => {
    const clients = fixture.accounts.map((account) => {
      const storage = new Map<string, string>();
      return createClient("http://127.0.0.1:54321", "sb_publishable_local_test_only", {
        auth: {
          autoRefreshToken: false,
          persistSession: true,
          storageKey: `independent-${account.user.id}`,
          storage: {
            getItem: (key) => storage.get(key) ?? null,
            setItem: (key, value) => {
              storage.set(key, value);
            },
            removeItem: (key) => {
              storage.delete(key);
            },
          },
        },
      });
    });
    try {
      for (const [index, client] of clients.entries()) {
        const result = await client.auth.signInWithPassword({
          email: fixture.accounts[index].user.email,
          password: "local-test-password",
        });
        assert.equal(result.error, null);
      }
      assert.equal((await clients[0].auth.signOut({ scope: "local" })).error, null);
      assert.equal((await clients[0].auth.getSession()).data.session, null);
      for (const index of [1, 2]) {
        assert.equal(
          (await clients[index].auth.getSession()).data.session?.user.id,
          fixture.accounts[index].user.id,
        );
        assert.equal(
          (await clients[index].auth.refreshSession()).data.session?.user.id,
          fixture.accounts[index].user.id,
        );
      }
    } finally {
      for (const client of clients) await client.auth.dispose();
    }
  });
});
