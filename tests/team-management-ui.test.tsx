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
import { loadTeam } from "@/lib/team-management";
const fixture = globalThis.__authFixture;
let auth: ReturnType<typeof useAuth>;
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, gcTime: Infinity },
    mutations: { retry: false, gcTime: Infinity },
  },
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
const router = createRouter({
  routeTree: rootRoute.addChildren(
    ["/account/team", "/account", "/login", "/home"].map((path) =>
      createRoute({
        path,
        getParentRoute: () => rootRoute,
        component: () =>
          path === "/login" ? (
            <p>Sign in</p>
          ) : (
            <RouteShell>
              <AccountAccessPanel />
            </RouteShell>
          ),
      }),
    ),
  ),
  history: createMemoryHistory({ initialEntries: ["/account/team"] }),
});
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
const text = () => document.body.textContent!;
async function waitFor(check: () => boolean, label: string) {
  for (let i = 0; i < 250; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    if (check()) return;
  }
  assert.fail("Timed out: " + label + "; " + text());
}
async function click(label: string) {
  const button = Array.from(document.querySelectorAll("button")).find(
    (el) => el.textContent === label || el.getAttribute("aria-label") === label,
  );
  assert.ok(button, label);
  await act(async () => button.click());
}
async function fill(id: string, value: string) {
  const el = document.getElementById(id) as HTMLInputElement;
  assert.ok(el, id);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}
async function submitInvite() {
  const form = document.querySelector("[role=dialog] form")!;
  assert.ok(form);
  await act(async () =>
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })),
  );
}
async function refresh() {
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: ["clinic_accounts"] });
  });
}
async function role(next: string) {
  fixture.accounts[0].role = next;
  await act(async () => window.dispatchEvent(new window.Event("focus")));
  await waitFor(() => auth.role === next, "role refresh");
}
after(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
  await supabase.auth.dispose();
  await globalThis.__cleanupAuthTests();
});

test("Team UI uses real Auth context, SDK, Owner controls and explicit revocation confirmation", async (t) => {
  await act(async () => root.render(<RouterProvider router={router} />));
  await act(async () => {
    assert.equal((await auth.signIn("clinic@example.test", "local-test-password")).error, null);
  });
  await act(async () => router.navigate({ to: "/account/team" }));
  await waitFor(() => text().includes("Clinic A second user"), "Owner directory");
  await t.test(
    "Owner sees only own clinic accounts, statuses and no Owner/self actions",
    async () => {
      assert.ok(text().includes("Active account"));
      assert.ok(!text().includes("Clinic B user"));
      assert.ok(document.querySelector('a[href="/account/team"]'));
      assert.ok(!document.querySelector('[aria-label="Revoke access for Clinic User"]'));
      assert.ok(!document.querySelector('select[aria-label="Access for Clinic User"]'));
    },
  );
  for (const next of ["manager", "staff"])
    await t.test("Owner invites " + next + " with no practitioner creation", async () => {
      await click("Invite user");
      await fill("team-invite-name", "New " + next);
      await fill("team-invite-email", next + "@example.test");
      const select = document.getElementById("team-invite-role") as HTMLSelectElement;
      assert.deepEqual(
        Array.from(select.options).map((o) => o.value),
        ["staff", "manager"],
      );
      await act(async () => {
        select.value = next;
        select.dispatchEvent(new window.Event("change", { bubbles: true }));
      });
      await submitInvite();
      await waitFor(
        () => !document.querySelector('[role="dialog"]') && text().includes("New " + next),
        "invited member",
      );
      assert.equal(fixture.teamInvitations.at(-1).role, next);
      assert.ok(text().includes("Invitation pending"));
      assert.ok(!fixture.requests.some((r) => r.method === "POST" && r.path === "/rest/v1/staff"));
    });
  await t.test(
    "Duplicate invitation shows safe pending message without raw provider diagnostics",
    async () => {
      await click("Invite user");
      await fill("team-invite-name", "Again");
      await fill("team-invite-email", "staff@example.test");
      await submitInvite();
      await waitFor(() => text().includes("pending invitation"), "duplicate error");
      assert.ok(!text().includes("PRIVATE_"));
      await click("Cancel");
    },
  );
  for (const [code, message] of [
    ["invite_recent", "An invitation was sent recently"],
    ["rate_limited", "Please wait before sending more invitations"],
  ]) {
    await t.test("Safe " + code + " message keeps the invite dialog usable", async () => {
      fixture.teamInviteRejection = code;
      await click("Invite user");
      await fill("team-invite-name", "Limited invite");
      await fill("team-invite-email", "limited@example.test");
      await submitInvite();
      await waitFor(() => text().includes(message), "safe invitation limit message");
      assert.ok(!text().includes("PRIVATE_") && !text().includes("429"));
      fixture.teamInviteRejection = null;
      await click("Cancel");
    });
  }
  await t.test(
    "Email failure is recoverable and resend is available for pending/expired links",
    async () => {
      fixture.teamEmailFailure = true;
      await click("Invite user");
      await fill("team-invite-name", "Email failure");
      await fill("team-invite-email", "mail@example.test");
      await submitInvite();
      await waitFor(() => text().includes("could not be sent"), "mailer error");
      fixture.teamEmailFailure = false;
      await click("Cancel");
      await click("Resend invitation");
      await waitFor(() => fixture.teamInvitations.at(-1)?.action === "resend", "resend");
    },
  );
  await t.test("Accepted invitation status removes resend action", async () => {
    const member = fixture.accounts.find((item) => item.user.email === "manager@example.test");
    member.inviteStatus = "accepted";
    await refresh();
    await waitFor(() => text().includes("Invite accepted"), "accepted status");
    const row = Array.from(document.querySelectorAll("li")).find((el) =>
      el.textContent?.includes("New manager"),
    )!;
    assert.ok(!row.textContent?.includes("Resend invitation"));
  });
  await t.test("Owner changes Staff/Manager both ways through role RPC", async () => {
    for (const next of ["manager", "staff"]) {
      const select = document.querySelector(
        'select[aria-label="Access for Clinic A second user"]',
      ) as HTMLSelectElement;
      await act(async () => {
        select.value = next;
        select.dispatchEvent(new window.Event("change", { bubbles: true }));
      });
      await waitFor(
        () => !select.disabled && fixture.roleChanges.at(-1)?.p_role === next,
        "role save",
      );
    }
  });
  await t.test("Revocation requires confirmation; cancel does not send a mutation", async () => {
    await click("Revoke access for Clinic A second user");
    assert.ok(text().includes("Revoke clinic access?"));
    assert.equal(fixture.teamRevocations.length, 0);
    await click("Keep access");
    assert.equal(fixture.teamRevocations.length, 0);
  });
  await t.test("Revocation failure stays open with a generic error and permits retry", async () => {
    fixture.teamRevokeFailure = true;
    await click("Revoke access for Clinic A second user");
    await click("Confirm revocation");
    await waitFor(() => text().includes("Could not revoke clinic access"), "revoke error");
    assert.ok(!text().includes("PRIVATE_REVOKE"));
    fixture.teamRevokeFailure = false;
    await click("Confirm revocation");
    await waitFor(
      () => !document.querySelector('[role="dialog"]') && text().includes("Access revoked"),
      "revoke success",
    );
    assert.equal(fixture.teamRevocations.length, 1);
    assert.ok(!document.querySelector('[aria-label="Revoke access for Clinic A second user"]'));
  });
  await t.test("Loading, empty and directory error states remain usable", async () => {
    fixture.teamEmpty = true;
    await refresh();
    await waitFor(() => text().includes("No portal accounts found"), "empty team");
    fixture.teamEmpty = false;
    fixture.teamError = true;
    await refresh();
    await waitFor(() => text().includes("Could not load clinic accounts"), "directory error");
    fixture.teamError = false;
    await click("Try again");
    await waitFor(() => text().includes("Clinic A second user"), "retry directory");
  });
  await t.test("Full roster loads beyond the provider's single-response limit", async () => {
    fixture.teamOverflow = true;
    try {
      const rows = await loadTeam();
      assert.ok(rows.length > 1002);
      assert.ok(rows.some((row) => row.full_name === "Overflow member 1001"));
    } finally {
      fixture.teamOverflow = false;
    }
  });
  await t.test(
    "Manager sees a read-only directory without invite/revoke/role controls",
    async () => {
      await role("manager");
      await waitFor(() => text().includes("Only clinic owners"), "Manager directory");
      assert.ok(
        !Array.from(document.querySelectorAll("button")).some(
          (el) => el.textContent === "Invite user" || el.textContent === "Revoke access",
        ),
      );
      assert.ok(!document.querySelector("select"));
    },
  );
  await t.test("Staff cannot enter Team and sees no private directory on Account", async () => {
    await role("staff");
    await waitFor(() => text().includes("isn’t available for your role"), "Staff Team denial");
    await act(async () => router.navigate({ to: "/account" }));
    assert.ok(!text().includes("Clinic A second user"));
    assert.ok(!document.querySelector('a[href="/account/team"]'));
  });
  await t.test(
    "Revoked retained session loses clinic association and cached clinic data on refresh",
    async () => {
      queryClient.setQueryData(["private-clinic-cache"], { patient: "private" });
      const existingSession = auth.session;
      fixture.accounts[0].revokedAt = new Date().toISOString();
      await act(async () => auth.refreshProfile());
      await waitFor(() => auth.clinicId === null, "revoked membership");
      assert.equal(auth.session?.user.id, existingSession?.user.id);
      assert.equal(queryClient.getQueryData(["private-clinic-cache"]), undefined);
      assert.ok(!text().includes("Clinic account access"));
    },
  );
});
