import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createClient } from "@supabase/supabase-js";
import { createClinicUserAdmin } from "../scripts/clinic-user-admin.server.mjs";
import { createProvisionClinicUserFunction } from "../supabase/functions/provision-clinic-user/function.ts";
import { provisionThroughEdge } from "../scripts/clinic-user-edge-client.mjs";
import {
  provisionClinicUser,
  parseClinicUserRequest,
  invitationRedirect,
  ClinicUserProvisionError,
} from "../src/lib/clinic-users.server.ts";
import {
  createClinicDatabase,
  loadSql,
  tenants,
  uuid,
  asUser,
  attempt,
} from "./helpers/clinic-database.mjs";

const [a, b] = tenants;
let db;
const users = new Map();
const requests = [];
let nextUser = 800;
let insertFailure = false;
let raceClinic = null;
let authFailure = false;
const origin = "http://127.0.0.1:54321";
const key = "sb_secret_local_fixture";
const reply = (status, data) =>
  new Response(status === 204 ? null : JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
// Supabase SDK calls stay in process. Auth responses are fixtures; profile and
// clinic queries execute against actual PostgreSQL with service-role grants.
const localFetch = async (input, init) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  assert.equal(url.origin, origin, "remote calls prohibited");
  requests.push({ path: url.pathname, method: req.method });
  if (![key, "sb_secret_named_fixture"].includes(req.headers.get("apikey")))
    return reply(403, { message: "Forbidden" });
  if (url.pathname === "/auth/v1/admin/generate_link") {
    const body = await req.json();
    assert.equal(body.type, "invite");
    assert.equal(url.searchParams.get("redirect_to"), "https://portal.example/account/setup");
    assert.deepEqual(Object.keys(body.data), ["full_name"]);
    if (authFailure) return reply(500, { msg: "SECRET_PROVIDER_FAILURE" });
    let user = [...users.values()].find((u) => u.email === body.email);
    if (!user) {
      user = {
        id: uuid(++nextUser),
        email: body.email,
        aud: "authenticated",
        role: "authenticated",
        email_confirmed_at: null,
      };
      users.set(user.id, user);
      await db.query("insert into auth.users(id,email) values ($1,$2)", [user.id, user.email]);
    }
    return reply(200, {
      ...user,
      action_link: `${origin}/auth/v1/verify?token=PRIVATE_INVITATION_${user.id}&type=invite`,
      verification_type: "invite",
      redirect_to: url.searchParams.get("redirect_to"),
    });
  }
  if (url.pathname.startsWith("/auth/v1/admin/users/")) {
    const user = users.get(url.pathname.split("/").pop());
    return user ? reply(200, { user }) : reply(404, { msg: "Not found" });
  }
  if (
    ![
      "/rest/v1/clinics",
      "/rest/v1/profiles",
      "/rest/v1/rpc/reserve_clinic_invitation",
      "/rest/v1/rpc/finish_clinic_invitation",
    ].includes(url.pathname)
  )
    throw new Error("Unexpected fixture request");
  await db.exec("begin; set local role service_role");
  await db.query("select set_config('request.jwt.claims',$1,true)", [
    JSON.stringify({ role: "service_role" }),
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
    } else if (req.method === "GET") {
      const table = url.pathname.endsWith("/clinics") ? "clinics" : "profiles";
      const column = table === "clinics" ? "id" : "auth_user_id";
      const value = url.searchParams.get(column)?.replace(/^eq\./, "");
      const fields = table === "clinics" ? "id" : "id,auth_user_id,clinic_id";
      result = (await db.query(`select ${fields} from public.${table} where ${column}=$1`, [value]))
        .rows;
    } else if (req.method === "POST") {
      assert.equal(url.pathname, "/rest/v1/profiles");
      const p = await req.json();
      if (insertFailure) {
        await db.exec("rollback");
        return reply(500, { code: "XX000", message: "SECRET_DATABASE_FAILURE" });
      }
      if (raceClinic) {
        await db.exec("savepoint competitor");
        try {
          await db.query(
            "insert into public.profiles(auth_user_id,clinic_id,email,full_name,role) values ($1,$2,$3,$4,$5)",
            [p.auth_user_id, raceClinic, p.email, "Concurrent member", "staff"],
          );
        } catch (error) {
          assert.equal(error.code, "42501");
          await db.exec("rollback to savepoint competitor");
        }
        await db.exec("release savepoint competitor");
        await db.exec("commit; begin; set local role service_role");
        raceClinic = null;
      }
      await db.query(
        "insert into public.profiles(auth_user_id,clinic_id,email,full_name,role) values ($1,$2,$3,$4,$5)",
        [p.auth_user_id, p.clinic_id, p.email, p.full_name, p.role],
      );
    } else throw new Error("Only SELECT and INSERT are permitted by provisioning");
    await db.exec("commit");
    return reply(req.method === "GET" || url.pathname.includes("/rpc/") ? 200 : 204, result);
  } catch (error) {
    await db.exec("rollback");
    return reply(400, { code: error.code, message: "Local database rejected operation" });
  }
};
const admin = createClinicUserAdmin({ SUPABASE_URL: origin, SUPABASE_SECRET_KEY: key }, localFetch);
const input = (email, clinicId = a.clinic) => ({
  mode: "invite",
  clinicId,
  email,
  fullName: "Additional member",
});
after(async () => {
  await admin.auth.dispose();
  await db?.close();
});

test("operator-assisted multi-user provisioning with actual PostgreSQL and mocked Auth", async (t) => {
  db = await createClinicDatabase({ team: true });
  await loadSql(db, "../tests/fixtures/10_clinic_access_privileges.sql");
  for (const tenant of tenants)
    users.set(tenant.user, {
      id: tenant.user,
      email: `${tenant.user}@example.test`,
      email_confirmed_at: "2026-01-01T00:00:00Z",
    });
  let member;
  await t.test("creates A2 in existing Clinic A without changing A1 or Clinic B", async () => {
    member = await provisionClinicUser(admin, input("a2@example.test"), "https://portal.example");
    assert.equal(member.clinicId, a.clinic);
    assert.ok(member.invitationUrl.includes("PRIVATE_INVITATION"));
    const p = (await db.query("select * from profiles where auth_user_id=$1", [member.authUserId]))
      .rows[0];
    assert.equal(p.role, "staff");
    assert.equal(p.email, "a2@example.test");
    assert.equal((await db.query("select count(*)::int as n from clinics")).rows[0].n, 3); // includes historical seed
    assert.equal(
      (await db.query("select clinic_id from profiles where auth_user_id=$1", [a.user])).rows[0]
        .clinic_id,
      a.clinic,
    );
  });
  await t.test(
    "A1/A2 share permitted data; B1 remains isolated; own profile details stay personal",
    async () => {
      for (const [user, clinic, other] of [
        [a.user, a.clinic, b.clinic],
        [member.authUserId, a.clinic, b.clinic],
        [b.user, b.clinic, a.clinic],
      ]) {
        await asUser(
          db,
          user,
          async () => {
            assert.equal((await db.query("select current_clinic_id() as id")).rows[0].id, clinic);
            for (const table of ["clients", "appointments", "conversations"]) {
              const rows = (await db.query(`select * from ${table}`)).rows;
              assert.ok(rows.length > 0);
              assert.ok(rows.every((r) => r.clinic_id === clinic));
              assert.equal(
                (await db.query(`select * from ${table} where clinic_id=$1`, [other])).rows.length,
                0,
              );
            }
            assert.equal(
              (
                await db.query(
                  "update profiles set full_name='Personal edit' where auth_user_id=$1 returning id",
                  [user],
                )
              ).rows.length,
              1,
            );
            assert.equal(
              (
                await db.query(
                  "update profiles set full_name='Tampered' where auth_user_id<>$1 returning id",
                  [user],
                )
              ).rows.length,
              0,
            );
            await assert.rejects(
              attempt(db, () =>
                db.query("update profiles set clinic_id=$1 where auth_user_id=$2", [other, user]),
              ),
              (e) => e.code === "42501",
            );
            await assert.rejects(
              attempt(db, () =>
                db.query(
                  "insert into profiles(auth_user_id,clinic_id,email,full_name) values ($1,$2,$3,$4)",
                  [uuid(900), other, "forged@example.test", "Forged"],
                ),
              ),
              (e) => e.code === "42501",
            );
          },
          { user_metadata: { clinic_id: other } },
        );
      }
    },
  );
  await t.test(
    "retry preserves profile details/role and does not duplicate membership",
    async () => {
      await db.query(
        "update profiles set full_name='Saved personal name',phone='123' where auth_user_id=$1",
        [member.authUserId],
      );
      const again = await provisionClinicUser(
        admin,
        input("a2@example.test"),
        "https://portal.example",
      );
      assert.equal(again.profileId, member.profileId);
      const p = (
        await db.query("select * from profiles where auth_user_id=$1", [member.authUserId])
      ).rows[0];
      assert.equal(p.full_name, "Saved personal name");
      assert.equal(p.phone, "123");
      assert.equal(p.role, "staff");
    },
  );
  await t.test(
    "refuses existing cross-clinic association; no membership update or link returned",
    async () => {
      await assert.rejects(
        provisionClinicUser(admin, input("a2@example.test", b.clinic), "https://portal.example"),
        ClinicUserProvisionError,
      );
      assert.equal(
        (
          await db.query("select clinic_id from profiles where auth_user_id=$1", [
            member.authUserId,
          ])
        ).rows[0].clinic_id,
        a.clinic,
      );
    },
  );
  await t.test(
    "associates an explicitly identified verified Auth user and preserves existing owners",
    async () => {
      const result = await provisionClinicUser(
        admin,
        {
          mode: "associate",
          clinicId: a.clinic,
          authUserId: a.user,
          email: `${a.user}@example.test`,
          fullName: "Do not overwrite",
        },
        "https://portal.example",
      );
      assert.equal(result.invitationUrl, null);
      assert.equal(
        (await db.query("select role from profiles where auth_user_id=$1", [a.user])).rows[0].role,
        "owner",
      );
      const u = {
        id: uuid(910),
        email: "existing@example.test",
        email_confirmed_at: "2026-01-01T00:00:00Z",
      };
      users.set(u.id, u);
      await db.query("insert into auth.users(id,email) values ($1,$2)", [u.id, u.email]);
      await provisionClinicUser(
        admin,
        {
          mode: "associate",
          clinicId: a.clinic,
          authUserId: u.id,
          email: u.email,
          fullName: "Existing user",
        },
        "https://portal.example",
      );
      assert.equal(
        (await db.query("select clinic_id from profiles where auth_user_id=$1", [u.id])).rows[0]
          .clinic_id,
        a.clinic,
      );
    },
  );
  await t.test(
    "identity mismatch/unverified user is rejected before a profile is inserted",
    async () => {
      for (const email of ["wrong@example.test", "a2@example.test"])
        await assert.rejects(
          provisionClinicUser(
            admin,
            {
              mode: "associate",
              clinicId: a.clinic,
              authUserId: member.authUserId,
              email,
              fullName: "Invalid",
            },
            "https://portal.example",
          ),
        );
    },
  );
  await t.test("validates clinic before generating an account", async () => {
    const start = requests.length;
    await assert.rejects(
      provisionClinicUser(
        admin,
        input("missing@example.test", uuid(999)),
        "https://portal.example",
      ),
    );
    assert.ok(!requests.slice(start).some((r) => r.path.startsWith("/auth/")));
  });
  await t.test("racing inserts cannot overwrite another clinic membership", async () => {
    raceClinic = b.clinic;
    await provisionClinicUser(admin, input("race@example.test"), "https://portal.example");
    assert.equal(
      (await db.query("select clinic_id from profiles where email='race@example.test'")).rows[0]
        .clinic_id,
      a.clinic,
    );
  });
  await t.test("same-clinic racing insert is idempotent", async () => {
    raceClinic = a.clinic;
    const r = await provisionClinicUser(
      admin,
      input("same-race@example.test"),
      "https://portal.example",
    );
    assert.equal(r.clinicId, a.clinic);
  });
  await t.test(
    "profile failure withholds link, reports recoverable Auth ID, and leaves user blocked",
    async () => {
      insertFailure = true;
      let failure;
      try {
        await provisionClinicUser(admin, input("partial@example.test"), "https://portal.example");
      } catch (e) {
        failure = e;
      } finally {
        insertFailure = false;
      }
      assert.ok(failure instanceof ClinicUserProvisionError);
      assert.ok(failure.authUserId);
      assert.ok(!failure.message.includes("SECRET"));
      assert.ok(!failure.message.includes("PRIVATE_INVITATION"));
      await asUser(db, failure.authUserId, async () =>
        assert.equal((await db.query("select current_clinic_id() as id")).rows[0].id, null),
      );
      const recovered = await provisionClinicUser(
        admin,
        input("partial@example.test"),
        "https://portal.example",
      );
      assert.equal(recovered.authUserId, failure.authUserId);
    },
  );
  await t.test("Auth failure exposes no raw provider body", async () => {
    authFailure = true;
    try {
      await assert.rejects(
        provisionClinicUser(admin, input("auth-fail@example.test"), "https://portal.example"),
        (e) => !e.message.includes("SECRET"),
      );
    } finally {
      authFailure = false;
    }
  });
  await t.test("browser credentials cannot invoke privileged provisioning", async () => {
    const browser = createClient(origin, "sb_publishable_local_fixture", {
      global: { fetch: localFetch },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    try {
      await assert.rejects(
        provisionClinicUser(browser, input("browser@example.test"), "https://portal.example"),
      );
    } finally {
      await browser.auth.dispose();
    }
  });
  await t.test(
    "rejects role injection, malformed identity, and unsafe redirects before external requests",
    () => {
      for (const extra of [{ role: "owner" }, { authUserId: a.user }, { clinicId: "bad" }])
        assert.throws(() => parseClinicUserRequest({ ...input("valid@example.test"), ...extra }));
      for (const url of [
        "http://remote.example",
        "https://user:secret@portal.example",
        "https://portal.example/path",
        "https://portal.example?redirect=bad",
      ])
        assert.throws(() => invitationRedirect(url));
      assert.equal(
        invitationRedirect("http://localhost:3000"),
        "http://localhost:3000/account/setup",
      );
    },
  );
  await t.test(
    "deployed Edge wrapper authenticates operators and invokes the same provisioning logic",
    async (t) => {
      const previousFetch = globalThis.fetch;
      const previousDeno = globalThis.Deno;
      globalThis.fetch = localFetch;
      const environment = {
        SUPABASE_URL: origin,
        SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: "sb_publishable_local_fixture" }),
        SUPABASE_SECRET_KEYS: JSON.stringify({ default: key, operator: "sb_secret_named_fixture" }),
        // Reproduce production: legacy runtime credential differs from modern key.
        SUPABASE_SERVICE_ROLE_KEY: "legacy-service-role-fixture",
        APERO_PORTAL_ORIGIN: "https://portal.example",
      };
      // Exercise the SDK's actual Deno runtime resolution, without env overrides.
      globalThis.Deno = { env: { get: (name) => environment[name] } };
      const edge = createProvisionClinicUserFunction((name) => environment[name]);
      const req = (body = input("edge-member@example.test"), headers = {}, method = "POST") =>
        new Request(`${origin}/functions/v1/provision-clinic-user`, {
          method,
          headers: { "content-type": "application/json", ...headers },
          ...(method === "POST"
            ? { body: typeof body === "string" ? body : JSON.stringify(body) }
            : {}),
        });
      try {
        await t.test(
          "missing, wrong, publishable, and user JWT credentials never reach Supabase operations",
          async () => {
            const start = requests.length;
            for (const headers of [
              {},
              { apikey: "wrong" },
              { apikey: "sb_secret_wrong_fixture" },
              { apikey: "sb_publishable_local_fixture" },
              { apikey: environment.SUPABASE_SERVICE_ROLE_KEY },
              { authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.user.signature" },
              { apikey: "sb_publishable_local_fixture", authorization: "Bearer user-session" },
            ]) {
              const response = await edge(req(undefined, headers));
              assert.equal(response.status, 401);
              const body = await response.text();
              for (const credential of [key, "sb_secret_named_fixture", "sb_secret_wrong_fixture"])
                assert.ok(!body.includes(credential), "auth errors must not disclose keys");
            }
            assert.equal(requests.length, start);
          },
        );
        await t.test(
          "pinned SDK secret mode rejects a non-default named key without provisioning",
          async () => {
            const start = requests.length;
            const response = await edge(
              req(input("named-operator@example.test"), { apikey: "sb_secret_named_fixture" }),
            );
            assert.equal(response.status, 401);
            assert.equal(requests.length, start);
          },
        );
        await t.test(
          "default runtime secret authenticates through SDK; Authorization-only credentials do not",
          async () => {
            // GET checks authentication but performs no database/Auth operations.
            const start = requests.length;
            assert.equal((await edge(req(undefined, { apikey: key }, "GET"))).status, 405);
            assert.equal(
              (await edge(req(undefined, { authorization: `Bearer ${key}` }, "GET"))).status,
              401,
            );
            assert.equal(requests.length, start);
          },
        );
        await t.test(
          "singular runtime secret works; missing or malformed runtime map fails closed",
          async () => {
            const original = environment.SUPABASE_SECRET_KEYS;
            const start = requests.length;
            try {
              delete environment.SUPABASE_SECRET_KEYS;
              environment.SUPABASE_SECRET_KEY = key;
              assert.equal((await edge(req(undefined, { apikey: key }, "GET"))).status, 405);
              delete environment.SUPABASE_SECRET_KEY;
              // SDK reports absent/malformed runtime credentials as configuration
              // errors (500), rather than accepting any credential or doing work.
              assert.equal((await edge(req(undefined, { apikey: key }, "GET"))).status, 500);
              environment.SUPABASE_SECRET_KEYS = "{invalid-json";
              assert.equal((await edge(req(undefined, { apikey: key }, "GET"))).status, 500);
              assert.equal(requests.length, start);
            } finally {
              environment.SUPABASE_SECRET_KEYS = original;
              delete environment.SUPABASE_SECRET_KEY;
            }
          },
        );
        await t.test(
          "authorized operator receives a verified membership/link without CORS or caching",
          async () => {
            const response = await edge(req(undefined, { apikey: key }));
            assert.equal(response.status, 200);
            assert.equal(response.headers.get("cache-control"), "no-store");
            assert.equal(response.headers.get("access-control-allow-origin"), null);
            const result = await response.json();
            assert.equal(result.clinicId, a.clinic);
            assert.ok(result.invitationUrl);
            assert.equal(
              (
                await db.query("select clinic_id from profiles where auth_user_id=$1", [
                  result.authUserId,
                ])
              ).rows[0].clinic_id,
              a.clinic,
            );
          },
        );
        await t.test(
          "invalid requests and portal configuration fail before provider operations",
          async () => {
            const start = requests.length;
            for (const [request, status] of [
              [req(undefined, { apikey: key, origin: "https://browser.example" }), 403],
              [req(undefined, { apikey: key }, "GET"), 405],
              [req(undefined, { apikey: key, "content-type": "text/plain" }), 415],
              [req("{bad-json", { apikey: key }), 400],
              [
                req(
                  { ...input("bad@example.test"), portalOrigin: "https://evil.example" },
                  { apikey: key },
                ),
                400,
              ],
              [req("x".repeat(9000), { apikey: key }), 413],
            ])
              assert.equal((await edge(request)).status, status);
            environment.APERO_PORTAL_ORIGIN = "";
            assert.equal((await edge(req(undefined, { apikey: key }))).status, 503);
            environment.APERO_PORTAL_ORIGIN = "https://portal.example";
            assert.equal(requests.length, start);
          },
        );
        await t.test("cross-clinic failure returns no invitation or provider secrets", async () => {
          const response = await edge(req(input("a2@example.test", b.clinic), { apikey: key }));
          assert.equal(response.status, 409);
          const result = await response.json();
          assert.equal(result.invitationUrl, undefined);
          assert.ok(!JSON.stringify(result).includes("PRIVATE_INVITATION"));
        });
        await t.test(
          "operator CLI remote transport reaches the protected function with the approved input",
          async () => {
            const result = await provisionThroughEdge(
              input("remote-tool@example.test"),
              origin,
              key,
              async (url, init) => {
                assert.equal(new URL(url).pathname, "/functions/v1/provision-clinic-user");
                assert.equal(init.redirect, "error");
                assert.equal(JSON.parse(init.body).portalOrigin, undefined);
                return edge(new Request(url, init));
              },
            );
            assert.equal(result.clinicId, a.clinic);
            await assert.rejects(
              provisionThroughEdge(input("a2@example.test", b.clinic), origin, key, (url, init) =>
                edge(new Request(url, init)),
              ),
              (error) => error instanceof ClinicUserProvisionError,
            );
          },
        );
      } finally {
        globalThis.fetch = previousFetch;
        if (previousDeno === undefined) delete globalThis.Deno;
        else globalThis.Deno = previousDeno;
      }
    },
  );
});
