// Exact synthetic production operations. Requires the operator's recorded grouped approval.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, stat, unlink } from "node:fs/promises";
import { randomBytes, randomUUID, randomInt, createHmac } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const REF = "svoybvzvmygszklcmudh",
  URL = `https://${REF}.supabase.co`;
const ROOT = "/tmp/apero-technical-closure",
  PRIVATE = `${ROOT}/private/fixtures.json`;
const OUT = "docs/release/2026-11-25-closure";
const mode = process.argv[2] ?? "check";
assert(
  [
    "check",
    "policy",
    "setup",
    "mfa",
    "lifecycle",
    "book",
    "reschedule",
    "cancel",
    "cleanup",
    "isolation",
  ].includes(mode),
);
const intent = JSON.parse(await readFile(`${ROOT}/operation-intent.json`, "utf8"));
assert(intent.target_project === REF);
if (mode === "check") {
  console.log(
    JSON.stringify({
      status: "PREPARED_NO_NETWORK",
      target_project: REF,
      clinics: 2,
      accounts: 5,
      modes: process.argv[2],
    }),
  );
} else {
  const approval = JSON.parse(await readFile(`${ROOT}/approval.json`, "utf8"));
  assert(
    approval.approved === true &&
      approval.run_id === intent.run_id &&
      approval.target_project === REF,
    "Explicit grouped production approval required",
  );
  assert(
    approval.actions?.[mode === "policy" ? "password_policy" : "hosted_synthetic"] === true,
    "Operation outside approved scope",
  );
  await mkdir(OUT, { recursive: true });
  const result = {
    run_id: intent.run_id,
    mode,
    started_at: new Date().toISOString(),
    tests: [],
    business_scope: "Exact new synthetic IDs only",
    emails: 0,
    calendar_writes: 0,
    retell_operations: 0,
  };
  const check = async (id, ok, details = {}) => {
    result.tests.push({ id, status: ok ? "PASS" : "FAIL", ...details });
    await saveResult();
    assert(ok, id);
  };
  const saveResult = () =>
    writeFile(`${OUT}/${mode}-result.json`, JSON.stringify(result, null, 2) + "\n");
  const token = (await readFile(`${process.env.HOME}/.supabase/access-token`, "utf8")).trim();
  async function management(path, body, method = body ? "POST" : "GET") {
    const response = await fetch(`https://api.supabase.com/v1/projects/${REF}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000),
      redirect: "error",
    });
    let data;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    return { status: response.status, data };
  }
  const keys = mode === "policy" ? { status: 200, data: [] } : await management("/api-keys");
  assert(keys.status === 200 && Array.isArray(keys.data), "Existing API key access unavailable");
  const secret = keys.data.find(
    (k) => k.type === "secret" && k.api_key?.startsWith("sb_secret_"),
  )?.api_key;
  const publicKey = keys.data.find(
    (k) => k.type === "publishable" && k.api_key?.startsWith("sb_publishable_"),
  )?.api_key;
  assert(
    mode === "policy" || (secret && publicKey),
    "Existing modern keys required; never create or rotate keys",
  );
  // Reuse the existing service-role JWT for the hosted operator SDK, without rotation.
  const legacy = keys.data.find(
    (k) => k.name === "service_role" && k.api_key?.startsWith("eyJ"),
  )?.api_key;
  assert(mode === "policy" || legacy, "Existing operator execution credential unavailable");
  const admin =
    mode === "policy"
      ? null
      : createClient(URL, legacy, {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        });
  const userClient = () =>
    createClient(URL, publicKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: {
        fetch: (input, options) => {
          const h = new Headers(input instanceof Request ? input.headers : undefined);
          new Headers(options?.headers).forEach((v, k) => h.set(k, v));
          if (/^Bearer sb_(publishable|secret)_/.test(h.get("Authorization") ?? ""))
            h.delete("Authorization");
          return fetch(input, {
            ...options,
            headers: h,
            signal: AbortSignal.timeout(30000),
            redirect: "error",
          });
        },
      },
    });
  const clients = [];
  let fixture;
  try {
    assert(((await stat(PRIVATE)).mode & 0o077) === 0);
    fixture = JSON.parse(await readFile(PRIVATE, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const persist = () =>
    writeFile(PRIVATE, JSON.stringify(fixture, null, 2) + "\n", { mode: 0o600 });
  const data = (response, label) => {
    if (response.error)
      result.operation_error = {
        stage: label,
        status: response.error.status,
        code: response.error.code,
        name: response.error.name,
      };
    assert(!response.error, label);
    return response.data;
  };
  async function isolationGuard(cid) {
    assert(/^[a-f0-9-]{36}$/i.test(cid), "Exact clinic UUID required");
    const response = await management("/database/query/read-only", {
      query: `select
        (select count(*) from public.calendar_connections where clinic_id='${cid}'::uuid) as connections,
        (select count(*) from public.integration_keys where clinic_id='${cid}'::uuid) as credentials,
        (select count(*) from public.clinic_retention where clinic_id='${cid}'::uuid and legal_hold) as holds`,
    });
    assert(response.status === 201 || response.status === 200, "Isolation metadata unavailable");
    assert(
      Array.isArray(response.data) && response.data.length === 1,
      "Isolation metadata malformed",
    );
    assert(
      Object.values(response.data[0]).every((count) => Number(count) === 0),
      "External integration or legal hold prevents synthetic operations",
    );
  }
  async function login(account) {
    const client = userClient();
    clients.push(client);
    const response = await client.auth.signInWithPassword({
      email: account.email,
      password: account.password,
    });
    assert(
      !response.error && response.data.user.id === account.auth_user_id,
      "Exact synthetic sign-in failed",
    );
    return client;
  }
  function totp(secret, offset = 0) {
    let bits = "";
    for (const c of secret.replace(/=+$/, "").toUpperCase()) {
      const n = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(c);
      assert(n >= 0);
      bits += n.toString(2).padStart(5, "0");
    }
    const key = Buffer.from(
      Array.from({ length: Math.floor(bits.length / 8) }, (_, i) =>
        parseInt(bits.slice(i * 8, i * 8 + 8), 2),
      ),
    );
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offset));
    const digest = createHmac("sha1", key).update(counter).digest(),
      i = digest.at(-1) & 15;
    return String((digest.readUInt32BE(i) & 0x7fffffff) % 1000000).padStart(6, "0");
  }
  async function verify(client, factor, seed) {
    const challenge = data(
      await client.auth.mfa.challenge({ factorId: factor }),
      "Challenge failed",
    );
    return client.auth.mfa.verify({
      factorId: factor,
      challengeId: challenge.id,
      code: totp(seed),
    });
  }
  try {
    if (mode === "policy") {
      const before = await management("/config/auth");
      assert(before.status === 200);
      const changed =
        before.data.password_min_length === 8
          ? { status: 200 }
          : await management("/config/auth", { password_min_length: 8 }, "PATCH");
      const after = await management("/config/auth");
      result.status =
        changed.status === 200 && after.data?.password_min_length === 8 ? "COMPLETE" : "BLOCKED";
      result.http = changed.status;
      result.server_minimum = after.data?.password_min_length;
      if (result.status === "BLOCKED")
        result.manual_action =
          "Project Authentication / Email provider: set Minimum password length to 8 and Save; or authorized administrator PATCH /config/auth with only password_min_length:8";
    } else if (mode === "setup") {
      if (!fixture) {
        fixture = {
          run_id: intent.run_id,
          target_project: REF,
          production_approved: true,
          synthetic: true,
          admitted: false,
          clinics: {},
          clients: {},
          practitioners: {},
          accounts: [],
          payloads: {},
          conversation_id: randomUUID(),
          appointment_id: randomUUID(),
        };
        for (const [label, role, tenant] of [
          ["owner-a", "owner", "a"],
          ["manager-a", "manager", "a"],
          ["staff-a", "staff", "a"],
          ["owner-b", "owner", "b"],
          ["manager-b", "manager", "b"],
        ])
          fixture.accounts.push({
            label,
            role,
            tenant,
            email: `${intent.run_id}-${label}@example.test`,
            password: randomBytes(24).toString("base64url") + "Aa9!",
          });
        await persist();
      }
      assert(fixture.run_id === intent.run_id && fixture.accounts.length === 5);
      for (const account of fixture.accounts) {
        if (!account.auth_user_id) {
          const created = data(
            await admin.auth.admin.createUser({
              email: account.email,
              password: account.password,
              email_confirm: true,
              user_metadata: {
                full_name: `APERO SYNTHETIC ${account.label}`,
                synthetic_run: intent.run_id,
              },
            }),
            "Synthetic Auth creation failed",
          );
          account.auth_user_id = created.user.id;
          await persist();
        }
      }
      const doc = await readFile("docs/onboarding/ADMINISTRATIVE_INTAKE.md", "utf8"),
        template = JSON.parse(doc.match(/```json\n([\s\S]*?)\n```/)[1]);
      for (const tenant of ["a", "b"]) {
        const owner = fixture.accounts.find((a) => a.label === `owner-${tenant}`);
        if (!fixture.payloads[tenant]) {
          const p = structuredClone(template);
          p.owner_auth_id = owner.auth_user_id;
          p.owner_name = `APERO SYNTHETIC Owner ${tenant}`;
          p.clinic.name = `APERO SYNTHETIC ${intent.run_id} ${tenant}`;
          p.clinic.localized_name = "عيادة اختبار اصطناعية";
          p.clinic.email = `${intent.run_id}-${tenant}@example.test`;
          p.clinic.phone = "+9655" + String(randomInt(1000000, 9999999));
          p.clinic.opening_hours.days = Array.from({ length: 7 }, (_, day) => ({
            day,
            periods: [{ start: "09:00", end: "17:00" }],
          }));
          p.services = [{ name: "Consultation", duration_minutes: 45 }];
          p.practitioners[0].availability = Array.from({ length: 7 }, (_, day) => ({
            day,
            start: "09:00",
            end: "17:00",
          }));
          fixture.payloads[tenant] = p;
          await persist();
        }
        const clinic = data(
          await admin.rpc("provision_clinic", {
            p_submission_key: `${intent.run_id}-${tenant}`,
            p_payload: fixture.payloads[tenant],
          }),
          "Trusted synthetic provisioning failed",
        );
        assert(
          typeof clinic === "string" &&
            (!fixture.clinics[tenant] || fixture.clinics[tenant] === clinic),
        );
        fixture.clinics[tenant] = clinic;
        for (const a of fixture.accounts.filter((a) => a.tenant === tenant)) a.clinic_id = clinic;
        await persist();
        for (const a of fixture.accounts.filter((a) => a.tenant === tenant)) {
          let rows = data(
            await admin
              .from("profiles")
              .select("id,clinic_id,role")
              .eq("auth_user_id", a.auth_user_id),
            "Profile verification failed",
          );
          if (!rows.length) {
            data(
              await admin.from("profiles").insert({
                auth_user_id: a.auth_user_id,
                clinic_id: clinic,
                email: a.email,
                full_name: `APERO SYNTHETIC ${a.label}`,
                role: "staff",
              }),
              "Synthetic membership failed",
            );
            rows = data(
              await admin
                .from("profiles")
                .select("id,clinic_id,role")
                .eq("auth_user_id", a.auth_user_id),
              "Profile recheck failed",
            );
          }
          assert(rows.length === 1 && rows[0].clinic_id === clinic);
          a.profile_id = rows[0].id;
          await persist();
        }
        const own = await login(owner);
        for (const manager of fixture.accounts.filter(
          (a) => a.tenant === tenant && a.role === "manager",
        ))
          data(
            await own.rpc("set_clinic_member_role", {
              p_profile_id: manager.profile_id,
              p_role: "manager",
            }),
            "Owner Manager assignment failed",
          );
        const staff = data(
          await admin.from("staff").select("id").eq("clinic_id", clinic),
          "Synthetic practitioner verification failed",
        );
        assert(staff.length === 1);
        fixture.practitioners[tenant] = staff[0].id;
        if (!fixture.clients[tenant]) {
          const row = data(
            await admin
              .from("clients")
              .insert({
                clinic_id: clinic,
                full_name: `APERO SYNTHETIC Client ${tenant}`,
                phone: "+96555550990",
                notes: intent.run_id,
              })
              .select("id")
              .single(),
            "Synthetic client failed",
          );
          fixture.clients[tenant] = row.id;
          await persist();
        }
      }
      const conversation = data(
        await admin.from("conversations").select("id").eq("id", fixture.conversation_id),
        "Conversation fixture read failed",
      );
      if (!conversation.length)
        data(
          await admin.from("conversations").insert({
            id: fixture.conversation_id,
            clinic_id: fixture.clinics.a,
            client_id: fixture.clients.a,
            title: "APERO SYNTHETIC recording",
            started_at: new Date().toISOString(),
            duration_seconds: 2,
            transcript: "Synthetic tone only",
            summary: "Synthetic fixture; no person or provider media",
          }),
          "Synthetic conversation failed",
        );
      const local = new Date(Date.now() + 86400000).toLocaleDateString("en-CA", {
        timeZone: "Asia/Kuwait",
      });
      fixture.appointment = {
        start_time: `${local}T06:00:00.000Z`,
        end_time: `${local}T06:45:00.000Z`,
        rescheduled_start_time: `${local}T07:30:00.000Z`,
        rescheduled_end_time: `${local}T08:15:00.000Z`,
      };
      for (const tenant of ["a", "b"]) {
        await isolationGuard(fixture.clinics[tenant]);
        const actual = data(
          await admin
            .from("profiles")
            .select("id,auth_user_id")
            .eq("clinic_id", fixture.clinics[tenant]),
          "Exact fixture admission failed",
        );
        assert(
          actual.length === fixture.accounts.filter((a) => a.tenant === tenant).length &&
            actual.every((row) =>
              fixture.accounts.some(
                (a) => a.profile_id === row.id && a.auth_user_id === row.auth_user_id,
              ),
            ),
        );
      }
      fixture.admitted = true;
      await persist();
      await check("HOSTED-TRUSTED-SYNTHETIC-SETUP", true, {
        clinics: 2,
        accounts: 5,
        clients: 2,
        practitioners: 2,
      });
      result.status = "COMPLETE";
    } else {
      assert(
        fixture?.admitted && fixture.production_approved && fixture.run_id === intent.run_id,
        "Admitted exact fixture required",
      );
      const ownerAccount = fixture.accounts.find((a) => a.label === "owner-a"),
        managerAccount = fixture.accounts.find((a) => a.label === "manager-a");
      const owner = await login(ownerAccount),
        manager = await login(managerAccount);
      if (mode === "mfa") {
        const policy = await management("/config/auth");
        if (policy.data.password_min_length === 8) {
          const weak = await owner.auth.updateUser({ password: "Aa1!aaa" });
          if (!weak.error) {
            data(
              await admin.auth.admin.updateUserById(ownerAccount.auth_user_id, {
                password: ownerAccount.password,
              }),
              "Strong fixture password restoration failed",
            );
          }
          await check("PASSWORD-SERVER-REJECTS-SEVEN", Boolean(weak.error), {
            http: weak.error?.status ?? 200,
          });
          const strong = randomBytes(24).toString("base64url") + "Aa9!";
          data(
            await owner.auth.updateUser({ password: strong }),
            "Strong password acceptance failed",
          );
          ownerAccount.password = strong;
          await persist();
          await check("PASSWORD-SERVER-ACCEPTS-STRONG", true);
        } else result.password_enforcement = "BLOCKED: minimum8 policy not yet applied";
        const primary = data(
          await owner.auth.mfa.enroll({ factorType: "totp", friendlyName: "Synthetic primary" }),
          "Primary enrollment failed",
        );
        const challenge = data(
          await owner.auth.mfa.challenge({ factorId: primary.id }),
          "Initial challenge failed",
        );
        let bad = "000000";
        while ([-1, 0, 1].some((n) => totp(primary.totp.secret, n) === bad))
          bad = String(Number(bad) + 1).padStart(6, "0");
        const invalid = await owner.auth.mfa.verify({
          factorId: primary.id,
          challengeId: challenge.id,
          code: bad,
        });
        await check("HOSTED-MFA-INVALID-CODE-DENIED", Boolean(invalid.error));
        data(await verify(owner, primary.id, primary.totp.secret), "Primary verification failed");
        await check(
          "HOSTED-MFA-PRIMARY-AAL2",
          data(await owner.auth.mfa.getAuthenticatorAssuranceLevel(), "AAL failed").currentLevel ===
            "aal2",
        );
        const backup = data(
          await owner.auth.mfa.enroll({ factorType: "totp", friendlyName: "Synthetic backup" }),
          "Backup enrollment failed",
        );
        data(await verify(owner, backup.id, backup.totp.secret), "Backup verification failed");
        const fresh = await login(ownerAccount);
        await check(
          "HOSTED-MFA-FIRST-FACTOR-AAL1",
          data(await fresh.auth.mfa.getAuthenticatorAssuranceLevel(), "AAL1 check failed")
            .currentLevel === "aal1",
        );
        const denied = await fresh.auth.mfa.unenroll({ factorId: primary.id });
        await check("HOSTED-MFA-AAL1-CANNOT-REMOVE-FACTOR", Boolean(denied.error));
        await new Promise((resolve) => setTimeout(resolve, 30500 - (Date.now() % 30000)));
        data(await verify(fresh, backup.id, backup.totp.secret), "Backup recovery step-up failed");
        data(
          await fresh.auth.mfa.unenroll({ factorId: primary.id }),
          "Lost primary removal failed",
        );
        await check(
          "HOSTED-MFA-BACKUP-RECOVERY",
          data(await fresh.auth.mfa.listFactors(), "Factor recovery check failed").totp.some(
            (f) => f.id === backup.id && f.status === "verified",
          ),
        );
        result.status = "COMPLETE";
      } else if (mode === "lifecycle") {
        const denied = async (id) => {
          const rows = await manager
            .from("clients")
            .select("id")
            .eq("clinic_id", fixture.clinics.a);
          await check(id, Boolean(rows.error) || rows.data.length === 0);
        };
        const banned = await admin.auth.admin.updateUserById(managerAccount.auth_user_id, {
          ban_duration: "1h",
        });
        data(banned, "Synthetic suspension failed");
        await denied("HOSTED-BANNED-RETAINED-JWT-DENIED");
        data(
          await admin.auth.admin.updateUserById(managerAccount.auth_user_id, {
            ban_duration: "none",
          }),
          "Synthetic unban failed",
        );
        await check(
          "HOSTED-ACCOUNT-RESTORED",
          data(
            await manager.from("clients").select("id").eq("id", fixture.clients.a),
            "Restore read failed",
          ).length === 1,
        );
        data(
          await owner.rpc("revoke_clinic_member", { p_profile_id: managerAccount.profile_id }),
          "Fixture revocation failed",
        );
        await denied("HOSTED-REVOKED-RETAINED-JWT-DENIED");
        data(
          await owner.rpc("reactivate_clinic_member", { p_profile_id: managerAccount.profile_id }),
          "Fixture restoration failed",
        );
        await check(
          "HOSTED-ROLE-PRESERVING-RESTORATION",
          data(await manager.rpc("current_profile_role"), "Restored role failed") === "manager",
        );
        data(
          await admin.rpc("decide_clinic_lifecycle", {
            p_clinic_id: fixture.clinics.a,
            p_action: "suspend",
            p_reason: `Synthetic acceptance ${intent.run_id}`,
            p_consent_revision: null,
            p_external_approved: false,
          }),
          "Fixture clinic suspension failed",
        );
        await denied("HOSTED-CLINIC-SUSPEND-RETAINED-JWT-DENIED");
        data(
          await admin.rpc("decide_clinic_lifecycle", {
            p_clinic_id: fixture.clinics.a,
            p_action: "reactivate",
            p_reason: `Synthetic acceptance ${intent.run_id}`,
            p_consent_revision: null,
            p_external_approved: false,
          }),
          "Fixture clinic restore failed",
        );
        await check(
          "HOSTED-CLINIC-RESTORE",
          data(
            await manager.from("clients").select("id").eq("id", fixture.clients.a),
            "Clinic restore read failed",
          ).length === 1,
        );
        result.status = "COMPLETE";
      } else if (mode === "isolation") {
        const foreign = await login(fixture.accounts.find((a) => a.label === "manager-b"));
        const select = await foreign
          .from("appointments")
          .select("id")
          .eq("id", fixture.appointment_id);
        await check(
          "HOSTED-EXISTING-APPOINTMENT-FOREIGN-READ-DENIED",
          !select.error && select.data.length === 0,
        );
        const update = await foreign
          .from("appointments")
          .update({ status: "Cancelled" })
          .eq("id", fixture.appointment_id)
          .select("id");
        await check(
          "HOSTED-EXISTING-APPOINTMENT-FOREIGN-UPDATE-DENIED",
          Boolean(update.error) || update.data.length === 0,
        );
        const retained = data(
          await manager
            .from("appointments")
            .select("status,start_time")
            .eq("id", fixture.appointment_id)
            .single(),
          "Own appointment retained check failed",
        );
        await check(
          "HOSTED-FOREIGN-REJECTION-PRESERVES-STATE",
          retained.status === "Booked" &&
            new Date(retained.start_time).toISOString() === fixture.appointment.start_time,
        );
        result.status = "COMPLETE";
      } else if (["book", "reschedule", "cancel"].includes(mode)) {
        if (mode === "book") {
          data(
            await manager.from("appointments").insert({
              id: fixture.appointment_id,
              clinic_id: fixture.clinics.a,
              client_id: fixture.clients.a,
              staff_id: fixture.practitioners.a,
              service: "Consultation",
              start_time: fixture.appointment.start_time,
              end_time: fixture.appointment.end_time,
            }),
            "Synthetic booking failed",
          );
          const duplicate = await manager.from("appointments").insert({
            id: randomUUID(),
            clinic_id: fixture.clinics.a,
            client_id: fixture.clients.a,
            staff_id: fixture.practitioners.a,
            service: "Consultation",
            start_time: fixture.appointment.start_time,
            end_time: fixture.appointment.end_time,
          });
          await check("HOSTED-DUPLICATE-CONFLICT-DENIED", Boolean(duplicate.error));
        }
        if (mode === "reschedule")
          data(
            await manager
              .from("appointments")
              .update({
                start_time: fixture.appointment.rescheduled_start_time,
                end_time: fixture.appointment.rescheduled_end_time,
              })
              .eq("id", fixture.appointment_id)
              .eq("clinic_id", fixture.clinics.a),
            "Synthetic move failed",
          );
        if (mode === "cancel")
          data(
            await manager
              .from("appointments")
              .update({ status: "Cancelled" })
              .eq("id", fixture.appointment_id)
              .eq("clinic_id", fixture.clinics.a),
            "Synthetic cancel failed",
          );
        const row = data(
          await manager
            .from("appointments")
            .select("id,status,start_time,end_time")
            .eq("id", fixture.appointment_id)
            .single(),
          "Mutated state read failed",
        );
        await check(
          `HOSTED-APPOINTMENT-${mode.toUpperCase()}`,
          mode === "cancel"
            ? row.status === "Cancelled"
            : new Date(row.start_time).toISOString() ===
                (mode === "book"
                  ? fixture.appointment.start_time
                  : fixture.appointment.rescheduled_start_time),
        );
        result.status = "COMPLETE";
      } else if (mode === "cleanup") {
        // The approved fixture erasure is exact-ID, with no global retention/policy change.
        for (const tenant of ["a", "b"]) {
          const cid = fixture.clinics[tenant];
          await isolationGuard(cid);
          const practitioners = data(
            await admin.from("staff").select("id").eq("clinic_id", cid),
            "Cleanup practitioner inventory failed",
          );
          assert(
            practitioners.every((p) => p.id === fixture.practitioners[tenant]),
            "Unlisted practitioner prevents cleanup",
          );
          const profiles = data(
            await admin.from("profiles").select("id").eq("clinic_id", cid),
            "Cleanup membership inventory failed",
          );
          assert(
            profiles.every((p) =>
              fixture.accounts.some((a) => a.profile_id === p.id && a.clinic_id === cid),
            ),
            "Unlisted member prevents cleanup",
          );
          const patients = data(
            await admin.from("clients").select("id").eq("clinic_id", cid),
            "Cleanup client inventory failed",
          );
          assert(
            patients.every((p) => p.id === fixture.clients[tenant]),
            "Unlisted client prevents cleanup",
          );
          const appointments = data(
            await admin.from("appointments").select("id,status").eq("clinic_id", cid),
            "Cleanup appointment inventory failed",
          );
          assert(
            appointments.every((a) => a.id === fixture.appointment_id && a.status === "Cancelled"),
            "Unlisted or active appointment prevents cleanup",
          );
          const conversations = data(
            await admin.from("conversations").select("id").eq("clinic_id", cid),
            "Cleanup conversation inventory failed",
          );
          assert(
            conversations.every((c) => c.id === fixture.conversation_id),
            "Unlisted conversation prevents cleanup",
          );
          if (tenant === "a") {
            data(
              await admin
                .from("appointments")
                .delete()
                .eq("id", fixture.appointment_id)
                .eq("clinic_id", cid),
              "Exact appointment cleanup failed",
            );
            data(
              await admin
                .from("conversations")
                .delete()
                .eq("id", fixture.conversation_id)
                .eq("clinic_id", cid),
              "Exact conversation cleanup failed",
            );
          }
          // Actually erase the synthetic contact before hard deletion; guards remain enabled.
          data(
            await admin
              .from("clients")
              .update({
                full_name: "Removed patient",
                phone: "",
                email: null,
                notes: null,
                anonymized_at: new Date().toISOString(),
              })
              .eq("id", fixture.clients[tenant])
              .eq("clinic_id", cid),
            "Exact synthetic anonymization failed",
          );
          data(
            await admin
              .from("clients")
              .delete()
              .eq("id", fixture.clients[tenant])
              .eq("clinic_id", cid),
            "Exact client cleanup failed",
          );
          data(await admin.from("clinics").delete().eq("id", cid), "Exact clinic cleanup failed");
          await check(
            `CLEANUP-CLINIC-${tenant}`,
            data(await admin.from("clinics").select("id").eq("id", cid), "Cleanup verify failed")
              .length === 0,
          );
        }
        for (const a of fixture.accounts) {
          data(await admin.auth.admin.deleteUser(a.auth_user_id), "Exact Auth cleanup failed");
          const absent = await admin.auth.admin.getUserById(a.auth_user_id);
          await check(
            `CLEANUP-AUTH-${a.label}`,
            absent.error?.status === 404 || absent.error?.code === "user_not_found",
          );
        }
        result.status = "COMPLETE";
        fixture.cleaned_at = new Date().toISOString();
        await persist();
      }
    }
  } catch (error) {
    result.status = "BLOCKED";
    result.failure = {
      name: error.name,
      stage: mode,
      reason:
        error.code === "ERR_ASSERTION"
          ? error.message.split("\n")[0]
          : "Sanitized operation failure; inspect exact synthetic journal before retry",
    };
    process.exitCode = 1;
  } finally {
    result.auth_session_cleanup = [];
    for (const c of clients) {
      const response = await c.auth.signOut({ scope: "local" });
      result.auth_session_cleanup.push({ local: true, success: !response.error });
    }
    result.finished_at = new Date().toISOString();
    await saveResult();
    console.log(
      JSON.stringify({
        mode,
        status: result.status,
        pass: result.tests.filter((t) => t.status === "PASS").length,
        fail: result.tests.filter((t) => t.status === "FAIL").length,
        ...(result.http ? { http: result.http } : {}),
      }),
    );
    if (fixture?.cleaned_at && result.status === "COMPLETE") await unlink(PRIVATE);
  }
}
