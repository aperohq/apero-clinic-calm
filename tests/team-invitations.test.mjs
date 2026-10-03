import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createClient } from "@supabase/supabase-js";
import { createTeamFunction } from "../supabase/functions/manage-clinic-users/function.ts";
import { createClinicDatabase, tenants, uuid } from "./helpers/clinic-database.mjs";
let db;
const [a, b] = tenants,
  manager = { user: uuid(510), profile: uuid(511) },
  staff = { user: uuid(610), profile: uuid(611) };
after(async () => {
  await db?.close();
});
const authUsers = new Map(),
  requests = [];
let nextUser = 1000,
  emailFailure = false,
  providerFailure = false,
  databaseFailure = false,
  raceRevocation = false;
const origin = "http://127.0.0.1:54321",
  portal = "https://portal.example",
  secret = "test-service-key",
  publicKey = "test-anon-key";
const tokenUsers = {
  "owner-token": a.user,
  "manager-token": manager.user,
  "staff-token": staff.user,
  "b-owner-token": b.user,
};
const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
async function addAuth(id, email, confirmed = false) {
  const user = {
    id,
    email,
    role: "authenticated",
    aud: "authenticated",
    invited_at: confirmed ? null : new Date().toISOString(),
    email_confirmed_at: confirmed ? new Date().toISOString() : null,
  };
  authUsers.set(id, user);
  await db.query(
    "insert into auth.users(id,email,invited_at,email_confirmed_at) values($1,$2,$3,$4) on conflict(id) do update set email=excluded.email,invited_at=excluded.invited_at,email_confirmed_at=excluded.email_confirmed_at",
    [id, email, user.invited_at, user.email_confirmed_at],
  );
  return user;
}
let transportQueue = Promise.resolve();
const localFetch = async (input, init) => {
  // PGlite has one connection. Serialize each individual HTTP transaction,
  // while concurrent Edge requests interleave between their HTTP operations.
  const previous = transportQueue;
  let release;
  transportQueue = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await executeLocalFetch(input, init);
  } finally {
    release();
  }
};
const executeLocalFetch = async (input, init) => {
  const req = new Request(input, init),
    url = new URL(req.url);
  assert.equal(url.origin, origin, "remote services prohibited");
  requests.push({ path: url.pathname, method: req.method });
  const apiKey = req.headers.get("apikey"),
    token = req.headers.get("authorization")?.replace(/^Bearer /, ""),
    actor = tokenUsers[token];
  if (url.pathname === "/auth/v1/user")
    return actor ? json(200, authUsers.get(actor)) : json(401, { msg: "Invalid token" });
  if (url.pathname.startsWith("/auth/v1/")) {
    assert.equal(apiKey, secret);
    if (url.pathname === "/auth/v1/admin/generate_link") {
      const body = await req.json();
      assert.equal(body.type, "invite");
      assert.equal(url.searchParams.get("redirect_to"), portal + "/account/setup");
      assert.deepEqual(Object.keys(body.data), ["full_name"]);
      if (providerFailure) return json(500, { msg: "SECRET_AUTH_DIAGNOSTIC" });
      let user = [...authUsers.values()].find((u) => u.email === body.email);
      if (user?.email_confirmed_at) return json(422, { msg: "GLOBAL_ACCOUNT_EXISTS" });
      if (!user) user = await addAuth(uuid(++nextUser), body.email);
      if (raceRevocation)
        await db.query("update profiles set revoked_at=now() where id=$1", [a.profile]);
      return json(200, {
        ...user,
        verification_type: "invite",
        action_link: "PRIVATE_INVITATION_LINK",
        redirect_to: portal + "/account/setup",
      });
    }
    if (url.pathname === "/auth/v1/invite") {
      const body = await req.json();
      assert.equal(url.searchParams.get("redirect_to"), portal + "/account/setup");
      const user = [...authUsers.values()].find((u) => u.email === body.email);
      assert.ok(user, "Auth invite already generated");
      const p = (await db.query("select * from profiles where auth_user_id=$1", [user.id])).rows[0];
      assert.ok(
        p && [a.clinic, b.clinic].includes(p.clinic_id) && !p.revoked_at,
        "verified membership exists BEFORE sending email",
      );
      if (emailFailure) return json(500, { msg: "PRIVATE_SMTP_DIAGNOSTIC" });
      return json(200, user);
    }
    throw Error("Unexpected Auth endpoint");
  }
  assert.ok(apiKey === secret || actor);
  await db.exec("begin; set local role " + (apiKey === secret ? "service_role" : "authenticated"));
  await db.query("select set_config('request.jwt.claims',$1,true)", [
    JSON.stringify({ role: apiKey === secret ? "service_role" : "authenticated", sub: actor }),
  ]);
  try {
    let result;
    if (url.pathname === "/rest/v1/rpc/reserve_clinic_invitation") {
      const p = await req.json();
      result = (
        await db.query("select reserve_clinic_invitation($1,$2,$3,$4,$5) value", [
          p.p_actor_auth_id,
          p.p_clinic_id,
          p.p_email,
          p.p_action,
          p.p_profile_id,
        ])
      ).rows[0].value;
    } else if (url.pathname === "/rest/v1/rpc/finish_clinic_invitation") {
      const p = await req.json();
      await db.query("select finish_clinic_invitation($1)", [p.p_token]);
      result = null;
    } else if (url.pathname === "/rest/v1/rpc/clinic_team_members") {
      result = (await db.query("select * from clinic_team_members()")).rows;
      const offset = Number(url.searchParams.get("offset") ?? 0);
      result = result.slice(offset, offset + 1000);
    } else if (url.pathname === "/rest/v1/rpc/owner_invite_email_available") {
      const p = await req.json();
      result = (
        await db.query("select owner_invite_email_available($1,$2) available", [
          p.p_actor_auth_id,
          p.p_email,
        ])
      ).rows[0].available;
    } else if (url.pathname === "/rest/v1/rpc/owner_invite_clinic_member") {
      const p = await req.json();
      if (databaseFailure)
        throw Object.assign(Error("PRIVATE_DATABASE_DIAGNOSTIC"), { code: "XX000" });
      result = (
        await db.query("select owner_invite_clinic_member($1,$2,$3,$4,$5) id", [
          p.p_actor_auth_id,
          p.p_auth_user_id,
          p.p_email,
          p.p_full_name,
          p.p_role,
        ])
      ).rows[0].id;
    } else if (["/rest/v1/profiles", "/rest/v1/clinics"].includes(url.pathname)) {
      const table = url.pathname.split("/").pop(),
        fields = url.searchParams.get("select");
      assert.ok(/^[a-z_,]+$/.test(fields));
      const filters = ["id", "auth_user_id", "clinic_id"].filter((k) => url.searchParams.has(k)),
        values = filters.map((k) => url.searchParams.get(k).slice(3));
      const sql =
        "select " +
        fields +
        " from " +
        table +
        (filters.length ? " where " + filters.map((k, i) => k + "=$" + (i + 1)).join(" and ") : "");
      result = (await db.query(sql, values)).rows;
      if (req.headers.get("accept")?.includes("object+json")) result = result[0];
    } else throw Error("Unexpected REST endpoint");
    await db.exec("commit");
    return json(200, result);
  } catch (error) {
    await db.exec("rollback");
    return json(403, { code: error.code ?? "XX000", message: "PRIVATE_DATABASE_DIAGNOSTIC" });
  }
};
const makeHandler = (limits) =>
  createTeamFunction(
    (name) =>
      ({
        APERO_PORTAL_ORIGIN: portal,
        SUPABASE_URL: origin,
        SUPABASE_ANON_KEY: publicKey,
        SUPABASE_SERVICE_ROLE_KEY: secret,
      })[name],
    (url, key, options) => createClient(url, key, options),
    localFetch,
    limits,
  );
const handler = makeHandler();
const call = async (body, token = "owner-token", extra = {}) => {
  const r = await handler(
    new Request(origin + "/functions/v1/manage-clinic-users", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + token,
        origin: portal,
        ...extra,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
  const data = await r.json();
  assert.ok(!JSON.stringify(data).match(/PRIVATE_|SECRET_|GLOBAL_|INVITATION_LINK/));
  assert.equal(r.headers.get("cache-control"), "no-store");
  return { status: r.status, ...data };
};
const input = (role = "staff", email = "new-" + role + "@example.test") => ({
  action: "invite",
  role,
  email,
  fullName: "New Member",
});

test("Authenticated Owner invitation boundary with real Supabase SDK and local PostgreSQL", async (t) => {
  db = await createClinicDatabase({ team: true, appointments: true });
  await db.query("select set_config('request.jwt.claims',$1,false)", [
    JSON.stringify({ role: "service_role" }),
  ]);
  for (const [m, role] of [
    [{ user: a.user }, "owner"],
    [{ user: b.user }, "owner"],
    [manager, "manager"],
    [staff, "staff"],
  ]) {
    await addAuth(m.user, m.user + "@example.test", true);
    if (m.profile)
      await db.query(
        "insert into profiles(id,auth_user_id,clinic_id,full_name,email,role) values($1,$2,$3,$4,$5,$6)",
        [m.profile, m.user, a.clinic, role, m.user + "@example.test", role],
      );
  }
  const practitionerBefore = (await db.query("select * from staff order by id")).rows;
  for (const role of ["manager", "staff"])
    await t.test("Owner invites " + role + " and email follows verified membership", async () => {
      const r = await call(input(role));
      assert.equal(r.status, 200);
      assert.equal(r.code, "invite_sent");
      assert.ok(r.profileId);
      const p = (await db.query("select * from profiles where id=$1", [r.profileId])).rows[0];
      assert.equal(p.role, role);
      assert.equal(p.clinic_id, a.clinic);
      assert.equal(p.revoked_at, null);
    });
  await t.test("No browser-returned links, tokens, Auth IDs or admin credentials", async () => {
    const r = await call(input("staff", "privacy@example.test"));
    assert.deepEqual(Object.keys(r).sort(), ["code", "profileId", "status"]);
  });
  await t.test(
    "Role Owner, foreign clinic, arbitrary Auth ID and invalid email are rejected",
    async () => {
      for (const body of [
        input("owner"),
        { ...input(), clinicId: b.clinic },
        { ...input(), authUserId: b.user },
        input("staff", "not-an-email"),
      ]) {
        const before = requests.length;
        assert.equal((await call(body)).status, 400);
        assert.ok(!requests.slice(before).some((r) => r.path === "/auth/v1/admin/generate_link"));
      }
    },
  );
  for (const token of ["manager-token", "staff-token"])
    await t.test(token + " cannot invoke invite/resend directly", async () => {
      for (const body of [input(), { action: "resend", profileId: a.profile }]) {
        const before = requests.length;
        assert.equal((await call(body, token)).status, 403);
        assert.ok(!requests.slice(before).some((r) => r.path.startsWith("/auth/v1/admin/")));
      }
    });
  await t.test("Invalid bearer, foreign Origin, methods and content type fail closed", async () => {
    assert.equal((await call(input(), "forged-token")).status, 401);
    assert.equal(
      (await call(input(), "owner-token", { origin: "https://evil.example" })).status,
      403,
    );
    assert.equal(
      (await call(input(), "owner-token", { "content-type": "text/plain" })).status,
      415,
    );
    assert.equal(
      (await handler(new Request(origin, { method: "GET", headers: { origin: portal } }))).status,
      405,
    );
    const preflight = await handler(
      new Request(origin, { method: "OPTIONS", headers: { origin: portal } }),
    );
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), portal);
    const response = await call("x".repeat(5000));
    assert.equal(response.status, 413);
  });
  await t.test(
    "Pending duplicate remains one membership; resend supports expired invitation recovery",
    async () => {
      const email = "new-staff@example.test",
        before = (await db.query("select count(*)::int n from profiles")).rows[0].n;
      assert.equal((await call(input("manager", email))).code, "invite_pending");
      const p = (await db.query("select * from profiles where email=$1", [email])).rows[0];
      assert.equal(p.role, "staff");
      assert.equal((await call({ action: "resend", profileId: p.id })).code, "invite_recent");
      await db.query(
        "update clinic_invitation_claims set last_attempt_at=now()-interval '61 seconds' where email=$1",
        [p.email],
      );
      assert.equal((await call({ action: "resend", profileId: p.id })).code, "invite_sent");
      assert.equal((await db.query("select count(*)::int n from profiles")).rows[0].n, before);
    },
  );
  await t.test("Accepted invite is reported and cannot be resent or reattached", async () => {
    const p = (await db.query("select * from profiles where email='new-manager@example.test'"))
      .rows[0];
    await db.query("update auth.users set email_confirmed_at=now() where id=$1", [p.auth_user_id]);
    authUsers.get(p.auth_user_id).email_confirmed_at = new Date().toISOString();
    assert.equal((await call(input("staff", p.email))).code, "already_member");
    assert.equal((await call({ action: "resend", profileId: p.id })).code, "already_member");
  });
  await t.test(
    "Existing global Auth accounts and foreign membership produce the same generic failure",
    async () => {
      await addAuth(uuid(1900), "global@example.test", true);
      const confirmed = await call(input("staff", "global@example.test"));
      assert.equal(confirmed.code, "invite_unavailable");
      const user = await addAuth(uuid(1901), "foreign@example.test");
      await db.query(
        "insert into profiles(auth_user_id,clinic_id,full_name,email,role) values($1,$2,'Foreign member',$3,'staff')",
        [user.id, b.clinic, user.email],
      );
      const start = requests.length;
      const foreign = await call(input("staff", user.email));
      assert.deepEqual(foreign, confirmed);
      assert.ok(!requests.slice(start).some((r) => r.path === "/auth/v1/admin/generate_link"));
      assert.equal(
        (await db.query("select clinic_id from profiles where auth_user_id=$1", [user.id])).rows[0]
          .clinic_id,
        b.clinic,
      );
      const p = (await db.query("select id from profiles where auth_user_id=$1", [user.id]))
        .rows[0];
      assert.equal((await call({ action: "resend", profileId: p.id })).status, 403);
    },
  );
  await t.test(
    "Email delivery failure preserves pending profile for safe retry; no Auth deletion",
    async () => {
      emailFailure = true;
      const r = await call(input("staff", "email-failure@example.test"));
      emailFailure = false;
      assert.equal(r.status, 502);
      assert.equal(r.code, "invite_email_failed");
      const p = (await db.query("select * from profiles where email='email-failure@example.test'"))
        .rows[0];
      assert.ok(p);
      assert.equal((await call({ action: "resend", profileId: p.id })).code, "invite_recent");
      await db.query(
        "update clinic_invitation_claims set last_attempt_at=now()-interval '61 seconds' where email=$1",
        [p.email],
      );
      assert.equal((await call({ action: "resend", profileId: p.id })).code, "invite_sent");
    },
  );
  await t.test("Backend/provider failure never sends email or exposes diagnostics", async () => {
    for (const failure of ["provider", "database"]) {
      providerFailure = failure === "provider";
      databaseFailure = failure === "database";
      const before = requests.length;
      assert.equal(
        (await call(input("staff", failure + "-failure@example.test"))).code,
        "invite_unavailable",
      );
      assert.ok(!requests.slice(before).some((r) => r.path === "/auth/v1/invite"));
    }
    providerFailure = databaseFailure = false;
  });
  await t.test(
    "Owner revoked during Auth provisioning cannot finish membership or email",
    async () => {
      raceRevocation = true;
      const before = requests.length;
      const r = await call(input("staff", "race-revoked@example.test"));
      raceRevocation = false;
      assert.equal(r.code, "invite_unavailable");
      assert.equal(
        (await db.query("select * from profiles where email='race-revoked@example.test'")).rows
          .length,
        0,
      );
      assert.ok(!requests.slice(before).some((r) => r.path === "/auth/v1/invite"));
      assert.equal((await call(input())).status, 403);
      await db.query("update profiles set revoked_at=null where id=$1", [a.profile]);
    },
  );
  await t.test(
    "Revoked target cannot be reinvited/resend and role is never restored implicitly",
    async () => {
      const p = (await db.query("select * from profiles where email='new-staff@example.test'"))
        .rows[0];
      await db.query("update profiles set revoked_at=now() where id=$1", [p.id]);
      assert.equal((await call(input("manager", p.email))).code, "access_revoked");
      assert.equal((await call({ action: "resend", profileId: p.id })).status, 403);
    },
  );
  await t.test(
    "Concurrent clinics invite one new normalized email: exactly one email/member and no losing Auth generation",
    async () => {
      const before = requests.length;
      const results = await Promise.all([
        call(input("staff", "concurrent-clinics@example.test"), "owner-token"),
        call(input("manager", "CONCURRENT-CLINICS@example.test"), "b-owner-token"),
      ]);
      assert.equal(results.filter((r) => r.code === "invite_sent").length, 1);
      assert.equal(results.filter((r) => r.code === "invite_unavailable").length, 1);
      const profiles = (
        await db.query("select * from profiles where email='concurrent-clinics@example.test'")
      ).rows;
      assert.equal(profiles.length, 1);
      const winner = results.findIndex((r) => r.code === "invite_sent");
      assert.equal(profiles[0].clinic_id, winner === 0 ? a.clinic : b.clinic);
      assert.equal(profiles[0].role, winner === 0 ? "staff" : "manager");
      const operations = requests.slice(before);
      assert.equal(operations.filter((r) => r.path === "/auth/v1/admin/generate_link").length, 1);
      assert.equal(operations.filter((r) => r.path === "/auth/v1/invite").length, 1);
    },
  );
  await t.test(
    "Same-clinic concurrent invite cannot duplicate membership or Auth generation",
    async () => {
      const before = requests.length;
      const results = await Promise.all([
        call(input("staff", "same-concurrent@example.test")),
        call(input("staff", "same-concurrent@example.test")),
      ]);
      assert.equal(results.filter((r) => r.code === "invite_sent").length, 1);
      assert.ok(results.some((r) => ["invite_recent", "invite_pending"].includes(r.code)));
      assert.equal(
        (await db.query("select * from profiles where email='same-concurrent@example.test'")).rows
          .length,
        1,
      );
      assert.equal(
        requests.slice(before).filter((r) => r.path === "/auth/v1/admin/generate_link").length,
        1,
      );
    },
  );
  await t.test(
    "Concurrent resends admit one mail call after cooldown and reject immediate repeats",
    async () => {
      const email = "same-concurrent@example.test";
      const p = (await db.query("select * from profiles where email=$1", [email])).rows[0];
      await db.query(
        "update clinic_invitation_claims set last_attempt_at=now()-interval '61 seconds' where email=$1",
        [email],
      );
      const before = requests.length;
      const results = await Promise.all([
        call({ action: "resend", profileId: p.id }),
        call({ action: "resend", profileId: p.id }),
      ]);
      assert.equal(results.filter((r) => r.code === "invite_sent").length, 1);
      assert.equal(results.filter((r) => r.code === "invite_recent").length, 1);
      assert.equal(requests.slice(before).filter((r) => r.path === "/auth/v1/invite").length, 1);
      assert.equal((await call({ action: "resend", profileId: p.id })).code, "invite_recent");
    },
  );
  await t.test(
    "Successful invite/resend are bounded to eight/six HTTP calls and two/one Auth Admin operations",
    async () => {
      // Reset only fixture budgets; no production connection exists.
      await db.exec("delete from clinic_invitation_budgets");
      const before = requests.length;
      const result = await call(input("staff", "bounded-success@example.test"));
      assert.equal(result.code, "invite_sent");
      const operations = requests.slice(before);
      assert.equal(operations.length, 8);
      assert.equal(
        operations.filter(
          (r) => r.path.startsWith("/auth/v1/admin/") || r.path === "/auth/v1/invite",
        ).length,
        2,
      );
      await db.query(
        "update clinic_invitation_claims set last_attempt_at=now()-interval '61 seconds' where email='bounded-success@example.test'",
      );
      const start = requests.length;
      assert.equal(
        (await call({ action: "resend", profileId: result.profileId })).code,
        "invite_sent",
      );
      assert.equal(requests.slice(start).length, 6);
      assert.equal(
        requests
          .slice(start)
          .filter((r) => r.path.startsWith("/auth/v1/admin/") || r.path === "/auth/v1/invite")
          .length,
        1,
      );
    },
  );
  await t.test(
    "Transport budget actually stops further work without automatic retries or Auth generation",
    async () => {
      const limited = makeHandler({ calls: 3, requestMs: 45000, fetchMs: 15000 });
      const before = requests.length;
      const response = await limited(
        new Request(origin + "/functions/v1/manage-clinic-users", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer owner-token",
            origin: portal,
          },
          body: JSON.stringify(input("staff", "budget-stop@example.test")),
        }),
      );
      assert.equal((await response.json()).code, "invite_unavailable");
      assert.equal(requests.slice(before).length, 3);
      assert.ok(!requests.slice(before).some((r) => r.path.startsWith("/auth/v1/admin/")));
      assert.equal(
        (await db.query("select * from profiles where email='budget-stop@example.test'")).rows
          .length,
        0,
      );
    },
  );
  await t.test(
    "Transport refuses a repeated Auth generation even if an SDK attempts it",
    async () => {
      const repeated = createTeamFunction(
        (name) =>
          ({
            APERO_PORTAL_ORIGIN: portal,
            SUPABASE_URL: origin,
            SUPABASE_ANON_KEY: publicKey,
            SUPABASE_SERVICE_ROLE_KEY: secret,
          })[name],
        (url, key, options) => {
          const client = createClient(url, key, options);
          if (key === secret) {
            const generate = client.auth.admin.generateLink.bind(client.auth.admin);
            client.auth.admin.generateLink = async (params) => {
              await generate(params);
              return await generate(params);
            };
          }
          return client;
        },
        localFetch,
      );
      const before = requests.length;
      const response = await repeated(
        new Request(origin + "/functions/v1/manage-clinic-users", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer owner-token",
            origin: portal,
          },
          body: JSON.stringify(input("staff", "repeated-sdk@example.test")),
        }),
      );
      assert.equal((await response.json()).code, "invite_unavailable");
      assert.equal(
        requests.slice(before).filter((r) => r.path === "/auth/v1/admin/generate_link").length,
        1,
      );
      assert.equal(requests.slice(before).filter((r) => r.path === "/auth/v1/invite").length, 0);
    },
  );
  await t.test("Total deadline aborts a stalled body read and returns a safe error", async () => {
    const bounded = makeHandler({ calls: 8, requestMs: 25, fetchMs: 15 });
    let cancelled = false;
    const body = new ReadableStream({
      start() {},
      cancel() {
        cancelled = true;
      },
    });
    const started = Date.now();
    // Keep the event loop alive while AbortSignal's unref'd test timer fires.
    const keepAlive = setInterval(() => {}, 10);
    try {
      const response = await bounded(
        new Request(origin + "/functions/v1/manage-clinic-users", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer owner-token",
            origin: portal,
          },
          body,
          duplex: "half",
        }),
      );
      assert.ok([400, 503].includes(response.status));
      assert.ok(Date.now() - started < 1000);
      assert.equal(cancelled, true);
      assert.ok(["invalid_input", "unavailable"].includes((await response.json()).code));
    } finally {
      clearInterval(keepAlive);
    }
  });
  await t.test(
    "Owner/clinic/target budgets return safe HTTP 429 before any Auth Admin work",
    async () => {
      const pending = (
        await db.query("select * from profiles where email='bounded-success@example.test'")
      ).rows[0];
      for (const scope of ["owner", "clinic", "email"]) {
        await db.exec("delete from clinic_invitation_budgets");
        if (scope !== "email")
          await db.query(
            "insert into clinic_invitation_budgets(scope,scope_id,attempts) values($1,$2,$3)",
            [scope, scope === "owner" ? a.user : a.clinic, scope === "owner" ? 30 : 60],
          );
        else
          await db.query(
            "update clinic_invitation_claims set email_attempts=5,last_attempt_at=now()-interval '61 seconds' where email=$1",
            [pending.email],
          );
        const before = requests.length;
        const result = await call(
          scope === "email"
            ? { action: "resend", profileId: pending.id }
            : input("staff", scope + "-rate-http@example.test"),
        );
        assert.deepEqual(result, { status: 429, code: "rate_limited" });
        assert.ok(
          !requests
            .slice(before)
            .some((r) => r.path.startsWith("/auth/v1/admin/") || r.path === "/auth/v1/invite"),
        );
      }
      await db.exec("delete from clinic_invitation_budgets");
    },
  );
  await t.test(
    "Total deadline cancels a stalled outbound Auth request without retries",
    async () => {
      let calls = 0,
        aborted = false;
      const bounded = createTeamFunction(
        (name) =>
          ({
            APERO_PORTAL_ORIGIN: portal,
            SUPABASE_URL: origin,
            SUPABASE_ANON_KEY: publicKey,
            SUPABASE_SERVICE_ROLE_KEY: secret,
          })[name],
        createClient,
        async (_input, init) => {
          calls++;
          return await new Promise((_resolve, reject) => {
            const abort = () => {
              aborted = true;
              reject(init.signal.reason);
            };
            init.signal.addEventListener("abort", abort, { once: true });
            if (init.signal.aborted) abort();
          });
        },
        { calls: 8, requestMs: 25, fetchMs: 1000 },
      );
      const start = Date.now();
      const response = await bounded(
        new Request(origin + "/functions/v1/manage-clinic-users", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer owner-token",
            origin: portal,
          },
          body: JSON.stringify(input()),
        }),
      );
      assert.ok([401, 503].includes(response.status));
      assert.equal(calls, 1);
      assert.equal(aborted, true);
      assert.ok(Date.now() - start < 1000);
      assert.ok(["not_authorized", "unavailable"].includes((await response.json()).code));
    },
  );
  await t.test("Practitioners remain untouched by all account operations", async () => {
    assert.deepEqual((await db.query("select * from staff order by id")).rows, practitionerBefore);
    assert.ok(!requests.some((r) => r.path.includes("/staff") || r.method === "DELETE"));
  });
  await t.test("Target lookup remains bounded beyond the provider response cap", async () => {
    await db.exec(`with identities as (
      insert into auth.users(id,email,email_confirmed_at)
      select gen_random_uuid(),'overflow-'||lpad(n::text,4,'0')||'@example.test',now()
      from generate_series(1,1005) as s(n) returning id,email
    ) insert into profiles(auth_user_id,clinic_id,full_name,email,role)
      select id,'${a.clinic}','ZZ Overflow '||email,email,'staff' from identities`);
    const before = requests.length;
    assert.equal((await call(input("staff", "overflow-1005@example.test"))).code, "already_member");
    assert.equal(
      requests.slice(before).filter((r) => r.path === "/rest/v1/rpc/clinic_team_members").length,
      0,
    );
    assert.equal(
      requests.slice(before).filter((r) => r.path === "/rest/v1/rpc/reserve_clinic_invitation")
        .length,
      1,
    );
  });
});
