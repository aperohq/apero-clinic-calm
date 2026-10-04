// Local only: real Supabase SDK, test HTTP responses, and a simulated browser.
// No production environment variables or remote services are used.
import { mkdtemp, rm } from "node:fs/promises";
import { MessageChannel } from "node:worker_threads";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { Window } from "happy-dom";

const user = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "clinic@example.test",
  aud: "authenticated",
  role: "authenticated",
  app_metadata: { provider: "email" },
  user_metadata: { clinic_id: "untrusted-clinic" },
  created_at: "2026-01-01T00:00:00Z",
};
const clinic = { id: "test-clinic", name: "Test Clinic", timezone: "Asia/Kuwait" };
const accounts = [
  {
    user,
    clinicId: "test-clinic",
    profileId: "test-profile",
    fullName: "Clinic User",
    role: "owner",
  },
  {
    user: { ...user, id: "00000000-0000-4000-8000-000000000002", email: "a2@example.test" },
    clinicId: "test-clinic",
    profileId: "a2-profile",
    fullName: "Clinic A second user",
    role: "staff",
  },
  {
    user: { ...user, id: "00000000-0000-4000-8000-000000000003", email: "b1@example.test" },
    clinicId: "second-clinic",
    profileId: "b1-profile",
    fullName: "Clinic B user",
    role: "owner",
  },
];
const refreshUsers = new Map();
let tokenNumber = 0;
const session = (authUser = user) => {
  const payload = Buffer.from(
    JSON.stringify({
      sub: authUser.id,
      exp: Math.floor(Date.now() / 1000) + 3600,
      n: ++tokenNumber,
    }),
  ).toString("base64url");
  const refreshToken = `local-refresh-${tokenNumber}`;
  refreshUsers.set(refreshToken, authUser);
  return {
    access_token: `eyJhbGciOiJIUzI1NiJ9.${payload}.test-signature`,
    refresh_token: refreshToken,
    token_type: "bearer",
    expires_in: 3600,
    user: authUser,
  };
};
const fixture = {
  settings: process.argv.includes("--settings"), settingsError: false, settingsDelay: 0, settingsSaveDelay: 0, settingsSaveError: false, settingsConflict: false, settingsUpdates: [],
  clinicValues: { localized_name: "العيادة", clinic_type: "Dental", phone: "+12025550100", email: "clinic@example.test", website: "https://clinic.example.test", fallback_phone: "+12025550199", address: "Building 1", city: "City", country: "Country", directions: "Ground floor", parking_information: "Visitor parking", receptionist_name: "Apero", receptionist_localized_name: "أبيرو", opening_hours: null },
  calendar: process.argv.includes("--calendar")
    ? {
        appointments: [],
        mutations: [],
        slotRequests: [],
        error: false,
        delay: 0,
        slotsError: false,
        slotsEmpty: false,
        conflict: false,
        conflictCode: "23P01",
      }
    : null,
  accounts,
  requests: [],
  missingProfile: false,
  profileError: false,
  logoutError: false,
  profileDelay: 0,
  clinicDelay: 0,
  missingClinic: false,
  clinicError: false,
  mismatchedUser: false,
  mismatchedClinic: false,
  profileClinicId: "test-clinic",
  inviteInvalid: process.argv.includes("--invite-invalid"),
  userDelay: process.argv.includes("--invite-setup") ? 180 : 0,
  passwordUpdates: [],
  accountPasswords: new Map(),
  passwordUpdateError: false,
  roleChanges: [],
  teamInvitations: [], teamRevocations: [], teamError: false, teamEmpty: false, teamEmailFailure: false, teamInviteRejection: null, teamRevokeFailure: false,
};
const origin = "http://127.0.0.1:54321";
const localFetch = async (req) => {
  const url = new URL(req.url);
  let account;
  try {
    const token = req.headers.get("authorization")?.replace(/^Bearer /, "");
    const subject = JSON.parse(Buffer.from(token?.split(".")[1] ?? "", "base64url").toString()).sub;
    account = accounts.find((item) => item.user.id === subject);
  } catch {
    /* Public Auth calls do not carry a user JWT. */
  }
  const resolvedClinicId =
    account?.user.id === user.id ? fixture.profileClinicId : account?.clinicId;
  fixture.requests.push({
    path: url.pathname,
    method: req.method,
    grant: url.searchParams.get("grant_type"),
    authorization: req.headers.get("authorization"),
    search: Object.fromEntries(url.searchParams),
  });
  const reply = (status, data) =>
    new Response(status === 204 ? null : JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json" },
    });
  if (url.pathname === "/auth/v1/token") {
    const input = await req.json();
    const authUser =
      url.searchParams.get("grant_type") === "refresh_token"
        ? refreshUsers.get(input.refresh_token)
        : input.password === (fixture.accountPasswords.get(input.email) ?? "local-test-password")
          ? accounts.find((item) => item.user.email === input.email)?.user
          : null;
    if (authUser) return reply(200, session(authUser));
    return reply(400, { code: "invalid_credentials", msg: "Invalid login credentials" });
  }
  if (url.pathname === "/auth/v1/logout")
    return fixture.logoutError ? reply(500, { msg: "Local test failure" }) : reply(204, null);
  if (url.pathname === "/auth/v1/user") {
    if (fixture.userDelay) await new Promise((resolve) => setTimeout(resolve, fixture.userDelay));
    if (req.method === "PUT") {
      if (!account) return reply(401, { msg: "Session expired" });
      const body = await req.json();
      fixture.passwordUpdates.push({ body, userId: account.user.id });
      if (fixture.passwordUpdateError) return reply(401, { msg: "Session expired" });
      fixture.accountPasswords.set(account.user.email, body.password);
      return reply(200, { user: account.user });
    }
    return reply(200, account?.user ?? user);
  }
  if (!req.headers.get("authorization")?.startsWith("Bearer eyJ"))
    return reply(401, { message: "Missing user token" });
  if (url.pathname === "/rest/v1/rpc/clinic_team_members") {
    if (!account || account.role === "staff" || account.revokedAt) return reply(403, { code: "42501" });
    if (fixture.teamError) return reply(500, { message: "PRIVATE_DIRECTORY_DIAGNOSTIC" });
    const rows = fixture.teamEmpty ? [] : accounts.filter(item => item.clinicId === resolvedClinicId).map(item => ({
      id: item.profileId, role: item.role, full_name: item.fullName, email: item.user.email,
      revoked_at: item.revokedAt ?? null, invite_status: item.revokedAt ? "revoked" : item.inviteStatus ?? "active",
      invited_at: item.inviteStatus ? "2026-10-01T00:00:00Z" : null, invite_accepted_at: null,
    }));
    if (fixture.teamOverflow) rows.push(...Array.from({ length: 1002 }, (_, n) => ({
      id: `overflow-${n}`, full_name: `Overflow member ${n}`, email: `overflow${n}@example.test`,
      role: "staff", revoked_at: null, invite_status: "active", invited_at: null, invite_accepted_at: null,
    })));
    return reply(200, rows.slice(Number(url.searchParams.get("offset") ?? 0), Number(url.searchParams.get("offset") ?? 0) + 1000));
  }
  if (url.pathname === "/functions/v1/manage-clinic-users") {
    const body = await req.json();
    if (account?.role !== "owner" || account.revokedAt) return reply(403, { code: "not_authorized" });
    fixture.teamInvitations.push(body);
    if (fixture.teamInviteRejection) return reply(429, { code: fixture.teamInviteRejection });
    if (fixture.teamEmailFailure) return reply(502, { code: "invite_email_failed" });
    if (body.action === "resend") return reply(200, { code: "invite_sent", profileId: body.profileId });
    if (accounts.some(item => item.clinicId === resolvedClinicId && item.user.email === body.email)) return reply(409, { code: "invite_pending" });
    const id = `00000000-0000-4000-8000-${String(accounts.length + 1).padStart(12, "0")}`;
    accounts.push({ user: { ...user, id, email: body.email }, clinicId: resolvedClinicId, profileId: id,
      fullName: body.fullName, role: body.role, inviteStatus: "pending" });
    return reply(200, { code: "invite_sent", profileId: id });
  }
  if (url.pathname === "/rest/v1/rpc/revoke_clinic_member") {
    const body = await req.json();const target = accounts.find(item => item.profileId === body.p_profile_id);
    if (fixture.teamRevokeFailure || account?.role !== "owner" || account.revokedAt || !target || target.clinicId !== resolvedClinicId || target.role === "owner" || target.user.id === account.user.id) return reply(403, { code: "42501", message: "PRIVATE_REVOKE_DIAGNOSTIC" });
    target.revokedAt = new Date().toISOString();fixture.teamRevocations.push(body);return reply(200, target.profileId);
  }
  if (url.pathname === "/rest/v1/rpc/set_clinic_member_role") {
    const body = await req.json();
    const target = accounts.find((item) => item.profileId === body.p_profile_id);
    if (
      account?.role !== "owner" ||
      !target ||
      target.clinicId !== resolvedClinicId ||
      target.role === "owner" ||
      !["manager", "staff"].includes(body.p_role)
    )
      return reply(403, { code: "42501", message: "Not authorized" });
    target.role = body.p_role;
    fixture.roleChanges.push(body);
    return reply(200, target.profileId);
  }
  if (url.pathname === "/rest/v1/profiles") {
    const missing = fixture.missingProfile || !!account?.revokedAt;
    const fail = fixture.profileError;
    if (fixture.profileDelay)
      await new Promise((resolve) => setTimeout(resolve, fixture.profileDelay));
    if (fail) return reply(403, { message: "Local profile read failure" });
    if (!url.searchParams.has("auth_user_id")) {
      const rows = accounts
        .filter(
          (item) =>
            item.clinicId === resolvedClinicId &&
            (account?.role !== "staff" || item.user.id === account.user.id) &&
            (!url.searchParams.has("id") || url.searchParams.get("id") === `eq.${item.profileId}`),
        )
        .map((item) => ({
          id: item.profileId,
          role: item.role,
          revoked_at: item.revokedAt ?? null,
          full_name: item.fullName,
          email: item.user.email,
        }));
      return reply(
        200,
        req.headers.get("accept")?.includes("application/vnd.pgrst.object+json") ? rows[0] : rows,
      );
    }
    return reply(
      200,
      missing
        ? []
        : [
            {
              id: account?.profileId,
              auth_user_id: fixture.mismatchedUser ? "different-auth-user" : account?.user.id,
              clinic_id: resolvedClinicId,
              full_name: account?.fullName,
              email: account?.user.email,
              role: account?.role,
              revoked_at: account?.revokedAt ?? null,
            },
          ],
    );
  }
  if (url.pathname === "/rest/v1/rpc/update_clinic_settings") {
    const body = await req.json(); fixture.settingsUpdates.push(body);
    if (fixture.settingsSaveDelay) await new Promise(resolve => setTimeout(resolve, fixture.settingsSaveDelay));
    if (account?.role !== "owner" || account.revokedAt) return reply(403, { code: "42501", message: "PRIVATE_SETTINGS_DIAGNOSTIC" });
    if (fixture.settingsSaveError) return reply(500, { message: "PRIVATE_SETTINGS_DIAGNOSTIC" });
    const current = { ...clinic, ...fixture.clinicValues };
    if (fixture.settingsConflict || Object.keys(body.p_expected).some(key => JSON.stringify(current[key]) !== JSON.stringify(body.p_expected[key]))) return reply(409, { code: "40001", message: "PRIVATE_SETTINGS_CONFLICT" });
    Object.assign(fixture.clinicValues, body.p_patch);
    return reply(200, { ...clinic, ...fixture.clinicValues });
  }
  if (url.pathname === "/rest/v1/clinics") {
    const settingsRead = fixture.settings && url.searchParams.get("select") !== "*";
    if (settingsRead && fixture.settingsDelay) await new Promise(resolve => setTimeout(resolve, fixture.settingsDelay));
    if (settingsRead && fixture.settingsError) return reply(500, { message: "PRIVATE_SETTINGS_DIAGNOSTIC" });
    const nextClinic = {
      ...clinic,
      ...(fixture.settings ? fixture.clinicValues : {}),
      id: fixture.mismatchedClinic ? "wrong-clinic" : resolvedClinicId,
    };
    const missing = fixture.missingClinic;
    const fail = fixture.clinicError;
    if (fixture.clinicDelay)
      await new Promise((resolve) => setTimeout(resolve, fixture.clinicDelay));
    if (fail) return reply(403, { message: "Local clinic read failure" });
    return reply(200, missing ? [] : req.headers.get("accept")?.includes("application/vnd.pgrst.object+json") ? nextClinic : [nextClinic]);
  }
  if (fixture.calendar && url.pathname === "/rest/v1/rpc/appointment_available_slots") {
    const body = await req.json();
    fixture.calendar.slotRequests.push(body);
    if (fixture.calendar.slotsError) return reply(500, { message: "Availability failed" });
    const ranges = fixture.calendar.slotsEmpty
      ? []
      : ["12:30", "13:15"].map((time) => {
          const begin = new Date(`${body.p_date}T${time}:00+03:00`);
          return {
            start_time: begin.toISOString(),
            end_time: new Date(begin.getTime() + 45 * 60000).toISOString(),
            duration_minutes: 45,
          };
        });
    return reply(200, ranges);
  }
  if (fixture.calendar && url.pathname === "/rest/v1/staff")
    return reply(200, [
      {
        id: "staff-a",
        clinic_id: resolvedClinicId,
        full_name: "Practitioner One",
        specialty: "General",
        services: ["Consultation"],
        active: true,
      },
      {
        id: "staff-b",
        clinic_id: resolvedClinicId,
        full_name: "Practitioner Two",
        specialty: "General",
        services: ["Consultation"],
        active: true,
      },
    ]);
  if (fixture.calendar && url.pathname === "/rest/v1/appointments") {
    const state = fixture.calendar;
    if (state.delay) await new Promise((resolve) => setTimeout(resolve, state.delay));
    if (state.error) return reply(500, { message: "Appointments failed" });
    const appointmentId = url.searchParams.get("id")?.slice(3);
    let rows = state.appointments.filter((row) => !appointmentId || row.id === appointmentId);
    if (req.method !== "GET") {
      const body = await req.json();
      state.mutations.push({
        method: req.method,
        body,
        id: appointmentId,
        clinic: url.searchParams.get("clinic_id"),
      });
      if (state.conflict)
        return reply(409, {
          code: state.conflictCode,
          message: "private Postgres diagnostic: deadlock detected or exclusion violation",
        });
      if (req.method === "POST") {
        const record = {
          ...body,
          id: `new-${state.mutations.length}`,
          updated_at: new Date().toISOString(),
          notes: null,
        };
        state.appointments.push(record);
        rows = [record];
      } else rows.forEach((row) => Object.assign(row, body));
    } else if (!appointmentId) {
      const before = url.searchParams.get("start_time")?.slice(3);
      const after = url.searchParams.get("end_time")?.slice(3);
      rows = rows.filter(
        (row) =>
          (!before || Date.parse(row.start_time) < Date.parse(before)) &&
          (!after || Date.parse(row.end_time) > Date.parse(after)),
      );
      const offset = Number(url.searchParams.get("offset") ?? 0);
      rows = rows.slice(offset, offset + 1000);
    }
    return reply(
      200,
      req.headers.get("accept")?.includes("application/vnd.pgrst.object+json") ? rows[0] : rows,
    );
  }
  if (
    [
      "clients",
      "staff",
      "appointments",
      "conversations",
      "client_notes",
      "staff_availability",
      "staff_time_off",
      "voice_requests",
    ].some((table) => url.pathname === `/rest/v1/${table}`)
  ) {
    if (url.pathname === "/rest/v1/clients") {
      const rows = ["test-clinic", "second-clinic"].map((clinicId) => ({
        id: `${clinicId}-client`,
        clinic_id: clinicId,
        full_name: `${clinicId} Patient`,
        phone: "123",
        email: null,
        notes: null,
      }));
      return reply(
        200,
        rows.filter(
          (row) =>
            row.clinic_id === resolvedClinicId &&
            `eq.${row.clinic_id}` === url.searchParams.get("clinic_id"),
        ),
      );
    }
    return reply(200, []);
  }
  return reply(404, { message: "Unexpected test request" });
};
const window = new Window({
  url: "http://localhost:3000/account",
  settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true },
});
for (const name of [
  "self",
  "window",
  "document",
  "navigator",
  "location",
  "localStorage",
  "sessionStorage",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLFormElement",
  "HTMLTextAreaElement",
  "NodeFilter",
  "Event",
  "KeyboardEvent",
  "FocusEvent",
  "HTMLSelectElement",
  "DocumentFragment",
  "CustomEvent",
  "PointerEvent",
  "ResizeObserver",
  "Element",
  "Node",
  "MutationObserver",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "scrollTo",
]) {
  Object.defineProperty(globalThis, name, {
    value:
      typeof window[name] === "function" &&
      ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "scrollTo"].includes(
        name,
      )
        ? window[name].bind(window)
        : window[name],
    configurable: true,
  });
}
const channels = [];
globalThis.MessageChannel = class extends MessageChannel {
  constructor() {
    super();
    channels.push(this);
  }
};
globalThis.BroadcastChannel = undefined;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.__authFixture = fixture;
// Fail closed if app code unexpectedly tries to contact a remote service.
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" ? input : (input.url ?? input.toString()));
  if (url.origin !== origin) throw new Error(`Non-local fetch blocked: ${url.origin}`);
  return localFetch(new Request(input, init));
};
const directory = await mkdtemp(join(tmpdir(), "apero-auth-tests-"));
globalThis.__cleanupAuthTests = async () => {
  await window.happyDOM.abort();
  for (const channel of channels) {
    channel.port1.close();
    channel.port2.close();
  }
  await rm(directory, { recursive: true, force: true });
};
try {
  await build({
    entryPoints: [
      fixture.calendar ? "tests/calendar-ui.test.tsx" : process.argv.includes("--settings") ? "tests/clinic-settings-ui.test.tsx" : process.argv.includes("--team") ? "tests/team-management-ui.test.tsx" : "tests/clinic-permission-ui.test.tsx",
    ],
    outfile: join(directory, "tests.cjs"),
    bundle: true,
    platform: "node",
    conditions: ["browser", "development"],
    format: "cjs",
    jsx: "automatic",
    define: {
      "import.meta.env": JSON.stringify({
        VITE_SUPABASE_URL: origin,
        VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_local_test_only",
      }),
      "process.env.NODE_ENV": '"development"',
    },
  });
  await import(pathToFileURL(join(directory, "tests.cjs")).href);
} catch (error) {
  await globalThis.__cleanupAuthTests();
  throw error;
}
