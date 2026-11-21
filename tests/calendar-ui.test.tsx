import { toast } from "sonner";
import { appointmentSlotConflictMessage } from "@/lib/appointment-conflicts";
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
import { CalendarPage } from "@/components/clinic-pages";
import { clinicWeek, calendarSegments } from "@/lib/calendar-layout";
import { clinicDayBoundary, fromClinicInput, toClinicInput } from "@/lib/clinic-time";
import type { AppointmentRow } from "@/lib/db-types";

const fixture = globalThis.__authFixture;
const state = fixture.calendar;
const toastErrors: string[] = [];
const originalToastError = toast.error;
toast.error = (message) => {
  toastErrors.push(String(message));
  return "test-toast";
};
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
const route = createRoute({
  path: "/calendar",
  getParentRoute: () => rootRoute,
  component: CalendarPage,
});
const router = createRouter({
  routeTree: rootRoute.addChildren([route]),
  history: createMemoryHistory({ initialEntries: ["/calendar"] }),
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
  assert.fail(`Timed out: ${label}; ${text()}`);
}
async function click(label: string) {
  const button = Array.from(document.querySelectorAll("button")).find(
    (el) => el.textContent === label || el.getAttribute("aria-label") === label,
  );
  assert.ok(button, `Button: ${label}`);
  await act(async () => button.click());
}
async function choose(label: string, value: string) {
  const trigger = document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
  assert.ok(trigger, `Select: ${label}`);
  await act(async () => {
    trigger.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  await waitFor(() => !!document.querySelector('[role="option"]'), "select options");
  const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((el) =>
    el.textContent?.includes(value),
  );
  assert.ok(option, `Option: ${value}`);
  await act(async () => option.click());
}
function record(
  id: string,
  staffId = "staff-a",
  start = "12:15",
  finish = "13:00",
  source = "Booked by Apero",
): AppointmentRow {
  const date = toClinicInput(new Date().toISOString(), "Asia/Kuwait").slice(0, 10);
  return {
    id,
    clinic_id: "test-clinic",
    client_id: "test-clinic-client",
    staff_id: staffId,
    service: "Consultation",
    start_time: fromClinicInput(`${date}T${start}`, "Asia/Kuwait"),
    end_time: fromClinicInput(`${date}T${finish}`, "Asia/Kuwait"),
    status: "Booked",
    source,
    notes: "Original notes",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}
async function refresh() {
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: ["appointments"] });
  });
}
after(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
  toast.error = originalToastError;
  await supabase.auth.dispose();
  await globalThis.__cleanupAuthTests();
});

test("clinic week, minute positions, overlap lanes, overnight records and browser-independent timezone", () => {
  const week = clinicWeek(new Date("2026-10-03T23:30Z"), "Asia/Kuwait", 0);
  assert.equal(week[0]!.toISOString().slice(0, 10), "2026-10-04");
  assert.equal(
    clinicWeek(new Date("2026-10-03T23:30Z"), "Asia/Kuwait", -1)[0]!.toISOString().slice(0, 10),
    "2026-09-27",
  );
  const a = { ...record("one"), start_time: "2026-10-04T06:15Z", end_time: "2026-10-04T07:45Z" };
  const b = {
    ...a,
    id: "two",
    staff_id: "staff-b",
    start_time: "2026-10-04T07:00Z",
    end_time: "2026-10-04T08:00Z",
  };
  const segments = calendarSegments([a, b], week, "Asia/Kuwait", "all");
  assert.equal(segments[0]!.start, 555);
  assert.equal(segments[0]!.end - segments[0]!.start, 90);
  assert.equal(segments[0]!.lanes, 2);
  assert.notEqual(segments[0]!.lane, segments[1]!.lane);
  assert.equal(calendarSegments([a, b], week, "Asia/Kuwait", "staff-a").length, 1);
  assert.equal(
    calendarSegments([{ ...a, status: "Cancelled" }], week, "Asia/Kuwait", "all").length,
    0,
  );
  const overnight = { ...a, start_time: "2026-10-04T20:30Z", end_time: "2026-10-04T21:30Z" };
  const split = calendarSegments([overnight], week, "Asia/Kuwait", "all");
  assert.deepEqual(
    split.map((s) => [s.day, s.start, s.end]),
    [
      [0, 1410, 1440],
      [1, 0, 30],
    ],
  );
  assert.equal(
    toClinicInput(clinicDayBoundary("2026-09-06", "America/Santiago"), "America/Santiago"),
    "2026-09-06T01:00",
  );
  const fallWeek = clinicWeek(new Date("2026-11-01T12:00Z"), "America/New_York", 0);
  const repeatedHour = { ...a, start_time: "2026-11-01T05:45Z", end_time: "2026-11-01T06:30Z" };
  const fall = calendarSegments([repeatedHour], fallWeek, "America/New_York", "all");
  assert.equal(fall.length, 1);
  assert.equal(fall[0]!.end - fall[0]!.start, 45);
  assert.throws(() => fromClinicInput("2026-03-08T02:30", "America/New_York"), /not valid/);
  assert.equal(toClinicInput("2026-10-04T06:15Z", "America/New_York"), "2026-10-04T02:15");
});

test("existing weekly calendar and appointment modal use real data hooks", async (t) => {
  state.appointments.push(
    record("ai-booking"),
    record("second-booking", "staff-b", "14:00", "14:45"),
  );
  await act(async () => root.render(<RouterProvider router={router} />));
  await waitFor(() => !auth.loading, "initial auth");
  await act(async () => {
    await auth.signIn("clinic@example.test", "local-test-password");
  });
  await waitFor(() => text().includes("New appointment"), "calendar loaded");
  await t.test("AI-created rows load in weekly calendar at minute position and duration", () => {
    const card = document.querySelector<HTMLButtonElement>('[aria-label*="45 min"]')!;
    assert.ok(card);
    assert.equal(card.style.top, "315px");
    assert.equal(card.style.height, "45px");
    const reads = fixture.requests.filter((r) => r.path === "/rest/v1/appointments");
    assert.ok(
      reads.some(
        (r) => r.search.start_time?.startsWith("lt.") && r.search.end_time?.startsWith("gt."),
      ),
    );
  });
  await t.test("next/previous week and Today load the right window and empty state", async () => {
    await click("Next week");
    await waitFor(() => text().includes("No appointments scheduled"), "empty next week");
    await click("Previous week");
    await waitFor(
      () => document.querySelectorAll('[aria-label*="45 min"]').length === 2,
      "previous week",
    );
    await click("Previous week");
    await waitFor(() => text().includes("No appointments scheduled"), "empty previous");
    await click("Today");
    await waitFor(() => document.querySelectorAll('[aria-label*="45 min"]').length === 2, "today");
  });
  await t.test("staff filter retains only that practitioner's appointments", async () => {
    const filter = document.querySelector<HTMLButtonElement>('[role="combobox"]')!;
    filter.setAttribute("aria-label", "Staff filter");
    await choose("Staff filter", "Practitioner One");
    assert.equal(document.querySelectorAll('[aria-label*="45 min"]').length, 1);
    await choose("Staff filter", "All staff");
  });
  await t.test(
    "details display real patient, practitioner, phone, source, notes and clinic time",
    async () => {
      await act(async () =>
        document.querySelector<HTMLButtonElement>('[aria-label*="45 min"]')!.click(),
      );
      await waitFor(() => text().includes("Appointment Details"), "details");
      for (const value of [
        "test-clinic Patient",
        "Practitioner One",
        "Booked by Apero",
        "Original notes",
        "Phone:",
        "45 min",
      ])
        assert.ok(text().includes(value), value);
      await click("Close");
    },
  );
  for (const code of ["23P01", "40P01"]) {
    await t.test(
      `${code}: failed reschedule preserves the original appointment and shows friendly conflict`,
      async () => {
        const before = structuredClone(state.appointments);
        await act(async () =>
          document.querySelector<HTMLButtonElement>('[aria-label*="45 min"]')!.click(),
        );
        await click("Reschedule");
        await waitFor(
          () => !!document.querySelector('[aria-label="Available appointment time"]'),
          "reschedule slots",
        );
        await choose("Available appointment time", "1:15");
        state.conflictCode = code;
        state.conflict = true;
        await click("Save");
        await waitFor(
          () =>
            Array.from(document.querySelectorAll<HTMLButtonElement>("button")).some(
              (b) => b.textContent === "Save" && b.disabled,
            ),
          "reschedule conflict selection reset",
        );
        assert.deepEqual(state.appointments, before);
        assert.equal(toastErrors.at(-1), appointmentSlotConflictMessage);
        state.conflict = false;
        await click("Cancel");
      },
    );
  }
  await t.test(
    "reschedule queries backend slots and updates the same ID then calendar",
    async () => {
      await act(async () =>
        document.querySelector<HTMLButtonElement>('[aria-label*="45 min"]')!.click(),
      );
      await click("Reschedule");
      await waitFor(
        () => !!document.querySelector('[aria-label="Available appointment time"]'),
        "slots",
      );
      assert.equal(state.slotRequests.at(-1).p_exclude_id, "ai-booking");
      await choose("Available appointment time", "1:15");
      await click("Save");
      await waitFor(() => !document.querySelector('[role="dialog"]'), "reschedule saved");
      const mutation = state.mutations.at(-1);
      assert.equal(mutation.id, "ai-booking");
      assert.deepEqual(Object.keys(mutation.body).sort(), ["end_time", "start_time"]);
      assert.equal(
        toClinicInput(state.appointments[0].start_time, "Asia/Kuwait").slice(11),
        "13:15",
      );
    },
  );
  await t.test(
    "cancellation requires confirmation, retains history/notes and removes the card",
    async () => {
      await act(async () =>
        document.querySelector<HTMLButtonElement>('[aria-label*="45 min"]')!.click(),
      );
      const before = state.mutations.length;
      await click("Cancel appointment");
      assert.equal(state.mutations.length, before);
      await click("Confirm cancellation");
      await waitFor(() => !document.querySelector('[role="dialog"]'), "cancel saved");
      assert.equal(state.appointments[0].status, "Cancelled");
      assert.equal(state.appointments[0].notes, "Original notes");
      assert.equal(state.appointments.length, 2);
      assert.equal(document.querySelectorAll('[aria-label*="45 min"]').length, 1);
    },
  );
  await t.test(
    "new appointment selects existing client/service/practitioner and backend slot",
    async () => {
      await click("New appointment");
      await choose("Client", "test-clinic Patient");
      await choose("Practitioner", "Practitioner One");
      await choose("Service", "Consultation");
      await waitFor(
        () => !!document.querySelector('[aria-label="Available appointment time"]'),
        "new slots",
      );
      await choose("Available appointment time", "12:30");
      await click("Save");
      await waitFor(() => !document.querySelector('[role="dialog"]'), "booking saved");
      const mutation = state.mutations.at(-1);
      assert.equal(mutation.method, "POST");
      assert.equal(mutation.body.client_id, "test-clinic-client");
      assert.equal(mutation.body.source, "Front desk");
      assert.equal(document.querySelectorAll('[aria-label*="45 min"]').length, 2);
    },
  );
  await t.test("booking a future week navigates directly to the saved appointment", async () => {
    await click("New appointment");
    await choose("Client", "test-clinic Patient");
    await choose("Practitioner", "Practitioner One");
    await choose("Service", "Consultation");
    const day = new Date();
    day.setDate(day.getDate() + 14);
    const date = toClinicInput(day.toISOString(), "Asia/Kuwait").slice(0, 10);
    const input = document.querySelector<HTMLInputElement>('[aria-label="Appointment date"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
        input,
        date,
      );
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await waitFor(
      () =>
        state.slotRequests.at(-1).p_date === date &&
        !!document.querySelector('[aria-label="Available appointment time"]'),
      "future slots",
    );
    await choose("Available appointment time", "12:30");
    await click("Save");
    await waitFor(
      () =>
        !document.querySelector('[role="dialog"]') &&
        document.querySelectorAll('[aria-label*="45 min"]').length === 1,
      "future appointment visible",
    );
    assert.equal(
      toClinicInput(state.appointments.at(-1).start_time, "Asia/Kuwait").slice(0, 10),
      date,
    );
    await click("Today");
    await waitFor(
      () => document.querySelectorAll('[aria-label*="45 min"]').length === 2,
      "back to today",
    );
  });
  for (const code of ["23P01", "40P01"]) {
    await t.test(
      `${code}: booking shows friendly conflict, retains dialog and clears stale slot`,
      async () => {
        await click("New appointment");
        await choose("Client", "test-clinic Patient");
        await choose("Practitioner", "Practitioner One");
        await choose("Service", "Consultation");
        await waitFor(
          () => !!document.querySelector('[aria-label="Available appointment time"]'),
          "conflict slots",
        );
        await choose("Available appointment time", "12:30");
        const before = structuredClone(state.appointments);
        state.conflictCode = code;
        state.conflict = true;
        await click("Save");
        await waitFor(
          () =>
            !!document.querySelector('[role="dialog"]') &&
            Array.from(document.querySelectorAll<HTMLButtonElement>("button")).some(
              (b) => b.textContent === "Save" && b.disabled,
            ),
          "conflict selection reset",
        );
        assert.deepEqual(state.appointments, before);
        assert.equal(toastErrors.at(-1), appointmentSlotConflictMessage);
        state.conflict = false;
        await click("Cancel");
      },
    );
  }
  await t.test("availability error and empty state are distinct", async () => {
    state.slotsError = true;
    await click("New appointment");
    await choose("Practitioner", "Practitioner One");
    await choose("Service", "Consultation");
    await waitFor(() => text().includes("Could not load availability"), "availability error");
    state.slotsError = false;
    state.slotsEmpty = true;
    await click("Try again");
    await waitFor(() => text().includes("No available slots"), "empty slots");
    state.slotsEmpty = false;
    await click("Cancel");
  });
  await t.test("calendar loading/error and retry use query state", async () => {
    state.delay = 100;
    await act(async () => {
      void queryClient.resetQueries({ queryKey: ["appointments"] });
    });
    await waitFor(() => text().includes("Loading clinic information"), "loading");
    state.delay = 0;
    await waitFor(() => text().includes("New appointment"), "loaded again");
    state.error = true;
    await refresh();
    await waitFor(() => text().includes("couldn’t load"), "calendar error");
    state.error = false;
    await click("Try again");
    await waitFor(() => text().includes("New appointment"), "retry");
  });
  for (const role of ["manager", "staff", "owner"]) {
    await t.test(`${role} retains normal calendar operations`, async () => {
      fixture.accounts[0].role = role;
      await act(async () => {
        window.dispatchEvent(new window.Event("focus"));
      });
      await waitFor(
        () => !auth.loading && auth.role === role && text().includes("New appointment"),
        "calendar role refresh",
      );
      assert.ok(document.querySelector('[aria-label*="45 min"]'));
      await act(async () =>
        document.querySelector<HTMLButtonElement>('[aria-label*="45 min"]')!.click(),
      );
      await waitFor(() => text().includes("Appointment Details"), "role details");
      for (const action of ["Reschedule", "Cancel appointment"])
        assert.ok(
          Array.from(document.querySelectorAll("button")).some(
            (button) => button.textContent === action,
          ),
        );
      await click("Close");
    });
  }
});
