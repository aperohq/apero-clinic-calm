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
import { ClinicSettingsPanel } from "@/components/clinic-settings-panel";
import { RouteShell } from "@/components/route-shell";

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
    ["/account/settings", "/account", "/login", "/home"].map((path) =>
      createRoute({
        path,
        getParentRoute: () => rootRoute,
        component: () =>
          path === "/login" ? (
            <p>Sign in</p>
          ) : (
            <RouteShell>
              <ClinicSettingsPanel />
            </RouteShell>
          ),
      }),
    ),
  ),
  history: createMemoryHistory({ initialEntries: ["/account/settings"] }),
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
    Object.getOwnPropertyDescriptor(
      el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      "value",
    )!.set!.call(el, value);
    el.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}
async function submitSettings() {
  const form = document.querySelector("form")!;
  assert.ok(form);
  await act(async () =>
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })),
  );
}
async function refresh() {
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: ["clinic_settings"] });
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

test("Settings UI uses canonical clinic values, real Auth/SDK, partial RPC saves and safe errors", async (t) => {
  fixture.settingsDelay = 60;
  await act(async () => root.render(<RouterProvider router={router} />));
  await act(async () =>
    assert.equal((await auth.signIn("clinic@example.test", "local-test-password")).error, null),
  );
  await act(async () => router.navigate({ to: "/account/settings" }));
  await t.test("Owner route shows loading then canonical onboarding values", async () => {
    await waitFor(() => text().includes("Loading clinic settings"), "loading");
    await waitFor(() => !!document.getElementById("settings-name"), "loaded settings");
    fixture.settingsDelay = 0;
    for (const [key, val] of Object.entries(fixture.clinicValues)) {
      if (key === "opening_hours" || key === "live_transfer_enabled") continue;
      assert.equal((document.getElementById("settings-" + key) as HTMLInputElement).value, val);
    }
    assert.equal(document.querySelector('nav a[href="/account/settings"]'), null);
    assert.ok(
      !Array.from(document.querySelectorAll("button")).some((b) => b.textContent === "Invite user"),
    );
    assert.equal(
      Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent === "Save settings",
      )!.disabled,
      true,
    );
  });
  await t.test(
    "Unchanged legacy email formatting cannot block an unrelated browser form submit",
    async () => {
      fixture.clinicValues.email = "legacy-invalid-email";
      await refresh();
      await waitFor(
        () =>
          (document.getElementById("settings-email") as HTMLInputElement).value ===
          "legacy-invalid-email",
        "legacy email loaded",
      );
      await fill("settings-name", "Legacy-compatible clinic");
      await click("Save settings");
      await waitFor(() => text().includes("Clinic settings saved."), "legacy-compatible save");
      assert.deepEqual(fixture.settingsUpdates.at(-1).p_patch, {
        name: "Legacy-compatible clinic",
      });
      assert.equal(fixture.clinicValues.email, "legacy-invalid-email");
      fixture.clinicValues.email = "clinic@example.test";
      await refresh();
      await waitFor(
        () =>
          (document.getElementById("settings-email") as HTMLInputElement).value ===
          "clinic@example.test",
        "valid email restored in fixture",
      );
    },
  );
  const edits = [
    ["name", "New clinic"],
    ["localized_name", "العيادة الجديدة"],
    ["clinic_type", "Medical clinic"],
    ["email", "new@example.test"],
    ["website", "https://new.example.test"],
    ["phone", "+12025550122"],
    ["address", "Building 2"],
    ["city", "New City"],
    ["country", "New Country"],
    ["directions", "Turn right"],
    ["parking_information", "Behind the building"],
    ["receptionist_name", "Receptionist"],
    ["receptionist_localized_name", "المساعدة"],
    ["fallback_phone", "+12025550123"],
    ["timezone", "Europe/London"],
  ];
  for (const [key, value] of edits)
    await t.test("Owner edits " + key + " without wiping other clinic values", async () => {
      const unrelated = fixture.clinicValues.address;
      await fill("settings-" + key, value);
      await submitSettings();
      await waitFor(() => text().includes("Clinic settings saved."), "save success");
      assert.deepEqual(fixture.settingsUpdates.at(-1).p_patch, { [key]: value });
      assert.equal(fixture.clinicValues[key], value);
      if (key !== "address") assert.equal(fixture.clinicValues.address, unrelated);
    });
  await t.test(
    "Timezone refresh updates the canonical dashboard Auth context without losing the form",
    async () => {
      await waitFor(() => auth.clinic?.timezone === "Europe/London", "clinic timezone refresh");
      assert.equal(
        (document.getElementById("settings-timezone") as HTMLInputElement).value,
        "Europe/London",
      );
    },
  );
  await t.test(
    "Malformed timezone and website/phone values fail locally with no backend work",
    async () => {
      for (const [key, bad, good] of [
        ["timezone", "bad/zone", "Europe/London"],
        ["website", "javascript:alert(1)", "https://new.example.test"],
        ["phone", "abcd", "+12025550122"],
      ]) {
        const before = fixture.settingsUpdates.length;
        await fill("settings-" + key, bad);
        await submitSettings();
        await waitFor(() => !!document.querySelector('[role="alert"]'), "validation");
        assert.equal(fixture.settingsUpdates.length, before);
        assert.equal((document.getElementById("settings-" + key) as HTMLInputElement).value, bad);
        await fill("settings-" + key, good);
      }
    },
  );
  await t.test("Optional clearing sends an explicit null only for the edited field", async () => {
    await fill("settings-website", "");
    await submitSettings();
    await waitFor(() => fixture.clinicValues.website === null, "cleared website");
    assert.deepEqual(fixture.settingsUpdates.at(-1).p_patch, { website: null });
    await waitFor(() => text().includes("Clinic settings saved."), "save settled");
  });
  await t.test(
    "Public hours support split shifts, closure days and clearing without touching staff schedules",
    async () => {
      const checkbox = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
      await act(async () => checkbox.click());
      await click("Add Monday hours");
      const input = document.querySelector(
        '[aria-label="Monday period 1 start"]',
      ) as HTMLInputElement;
      assert.ok(input);
      assert.equal(input.value, "09:00");
      await submitSettings();
      await waitFor(() => text().includes("Clinic settings saved."), "hours save");
      await waitFor(() => !!auth.clinic?.opening_hours, "hours context refresh");
      const previousProfile = auth.profile;
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      assert.equal(
        auth.profile,
        previousProfile,
        "unchanged nested clinic configuration preserves profile identity",
      );
      const saved = fixture.settingsUpdates.at(-1).p_patch.opening_hours;
      assert.equal(saved.days[1].periods[0].end, "17:00");
      assert.deepEqual(saved.days[0].periods, []);
      assert.ok(text().includes("do not restrict appointment availability"));
      assert.ok(
        !fixture.requests.some(
          (r) =>
            r.method !== "GET" &&
            ["/rest/v1/staff_availability", "/rest/v1/staff_time_off"].includes(r.path),
        ),
      );
      await act(async () => checkbox.click());
      await submitSettings();
      await waitFor(() => fixture.clinicValues.opening_hours === null, "hours cleared");
      await waitFor(() => text().includes("Clinic settings saved."), "clear settled");
    },
  );
  await t.test("Owner controls the default-off transfer flag without changing destination or hours", async () => {
    const destination = fixture.clinicValues.fallback_phone;
    const hours = structuredClone(fixture.clinicValues.opening_hours);
    const checkbox = document.getElementById("settings-live-transfer") as HTMLInputElement;
    assert.equal(checkbox.checked, false);
    for (const enabled of [true, false]) {
      await act(async () => checkbox.click());
      await submitSettings();
      await waitFor(() => text().includes("Clinic settings saved."), "transfer flag save");
      assert.deepEqual(fixture.settingsUpdates.at(-1).p_patch, {live_transfer_enabled: enabled});
      assert.equal(fixture.clinicValues.fallback_phone, destination);
      assert.deepEqual(fixture.clinicValues.opening_hours, hours);
    }
  });
  await t.test("Server failure is generic and preserves unsaved edits for retry", async () => {
    fixture.settingsSaveError = true;
    await fill("settings-name", "Recoverable edit");
    await submitSettings();
    await waitFor(() => text().includes("Could not save clinic settings"), "safe failure");
    assert.ok(
      !text().includes("PRIVATE_") && !text().includes("Supabase") && !text().includes("500"),
    );
    assert.equal(
      (document.getElementById("settings-name") as HTMLInputElement).value,
      "Recoverable edit",
    );
    fixture.settingsSaveError = false;
    await submitSettings();
    await waitFor(() => text().includes("Clinic settings saved."), "retry saved");
  });
  await t.test("Strict duplicate-submit guard permits only one in-flight save", async () => {
    fixture.settingsSaveDelay = 100;
    await fill("settings-city", "One submit");
    const before = fixture.settingsUpdates.length;
    const form = document.querySelector("form")!;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await waitFor(() => text().includes("Saving…"), "saving state");
    assert.equal(
      (document.getElementById("settings-name") as HTMLInputElement).closest("fieldset")!.disabled,
      true,
    );
    await waitFor(() => text().includes("Clinic settings saved."), "one save settled");
    assert.equal(fixture.settingsUpdates.length, before + 1);
    fixture.settingsSaveDelay = 0;
  });
  await t.test("Background Auth/query refresh preserves unsaved form state", async () => {
    await fill("settings-directions", "Keep this draft");
    fixture.clinicValues.country = "Updated elsewhere";
    await act(async () => window.dispatchEvent(new Event("focus")));
    await refresh();
    assert.equal(
      (document.getElementById("settings-directions") as HTMLInputElement).value,
      "Keep this draft",
    );
    assert.ok(text().includes("Unsaved changes"));
  });
  await t.test("Navigation and reload require explicit discard confirmation", async () => {
    await act(async () => {
      void router.navigate({ to: "/home" });
    });
    await waitFor(() => text().includes("Discard unsaved changes?"), "navigation guard");
    await click("Keep editing");
    assert.equal(router.state.location.pathname, "/account/settings");
    await click("Reload saved values");
    await waitFor(() => text().includes("Discard unsaved changes?"), "reload guard");
    await click("Keep editing");
    assert.equal(
      (document.getElementById("settings-directions") as HTMLInputElement).value,
      "Keep this draft",
    );
    await click("Reload saved values");
    await click("Discard changes");
    await waitFor(() => !document.querySelector('[role="dialog"]'), "reloaded");
    assert.equal(
      (document.getElementById("settings-country") as HTMLInputElement).value,
      "Updated elsewhere",
    );
  });
  await t.test(
    "Stale-field conflict is safe and never silently overwrites the newer value",
    async () => {
      fixture.settingsConflict = true;
      await fill("settings-name", "Stale draft");
      await submitSettings();
      await waitFor(() => text().includes("another session"), "conflict");
      assert.equal(
        (document.getElementById("settings-name") as HTMLInputElement).value,
        "Stale draft",
      );
      assert.ok(!text().includes("PRIVATE_"));
      fixture.settingsConflict = false;
      await click("Reload saved values");
      await click("Discard changes");
      await waitFor(() => !document.querySelector('[role="dialog"]'), "discard conflict");
    },
  );
  await t.test("Load failure is generic and retry returns persisted settings", async () => {
    queryClient.removeQueries({ queryKey: ["clinic_settings"] });
    fixture.settingsError = true;
    await role("manager");
    await role("owner");
    await waitFor(
      () => text().includes("Could not load clinic settings"),
      "directory load failure",
    );
    assert.ok(!text().includes("PRIVATE_"));
    fixture.settingsError = false;
    await click("Try again");
    await waitFor(() => !!document.getElementById("settings-name"), "load retry");
  });
  for (const next of ["manager", "staff"])
    await t.test(next + " cannot enter Settings or see clinic edit controls", async () => {
      await role(next);
      await waitFor(() => text().includes("isn’t available for your role"), "role denied");
      assert.ok(!document.getElementById("settings-name"));
      assert.ok(!document.querySelector('a[href="/account/settings"]'));
      assert.ok(
        !Array.from(document.querySelectorAll("button")).some(
          (b) => b.textContent === "Save settings",
        ),
      );
    });
  await t.test("A late save response cannot repopulate clinic caches after logout", async () => {
    await role("owner");
    await waitFor(() => !!document.getElementById("settings-name"), "Owner settings");
    fixture.settingsSaveDelay = 150;
    await fill("settings-name", "Pending before logout");
    await submitSettings();
    await waitFor(() => text().includes("Saving…"), "in-flight save");
    await act(async () => {
      assert.equal((await auth.signOut()).error, null);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 180));
    });
    assert.equal(auth.session, null);
    assert.equal(queryClient.getQueryCache().getAll().length, 0);
    fixture.settingsSaveDelay = 0;
    await act(async () => {
      assert.equal((await auth.signIn("clinic@example.test", "local-test-password")).error, null);
    });
    await act(async () => router.navigate({ to: "/account/settings" }));
    await waitFor(() => !!document.getElementById("settings-name"), "Owner re-login");
  });
  await t.test(
    "Newly revoked retained Owner loses the Settings UI and cached clinic data",
    async () => {
      await role("owner");
      await waitFor(() => !!document.getElementById("settings-name"), "Owner restored fixture");
      fixture.accounts[0].revokedAt = "2026-10-03T10:00:00Z";
      await act(async () => window.dispatchEvent(new Event("focus")));
      await waitFor(() => auth.clinicId === null, "revoked association");
      assert.ok(!document.getElementById("settings-name"));
      assert.equal(queryClient.getQueryCache().getAll().length, 0);
    },
  );
});
