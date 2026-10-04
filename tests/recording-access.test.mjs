import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { createRecordingAccessFunction } from "../supabase/functions/recording-access/function.ts";
import {
  createClinicDatabase,
  loadSql,
  tenants,
  uuid,
  asUser,
  asRole,
  attempt,
} from "./helpers/clinic-database.mjs";

test("recording access uses authenticated membership, real RLS, and fresh provider access", async (t) => {
  const db = await createClinicDatabase({ team: true });
  const [a, b] = tenants;
  const manager = uuid(701),
    staff = uuid(702),
    unlinked = uuid(703);
  const portal = "https://portal.example",
    origin = "http://127.0.0.1:54321";
  const tokens = { owner: a.user, foreign: b.user, manager, staff, unlinked };
  let providerCalls = 0,
    mode = "signed";
  const env = {
    APERO_PORTAL_ORIGIN: portal,
    SUPABASE_URL: origin,
    SUPABASE_ANON_KEY: "local-publishable-key",
    SUPABASE_SERVICE_ROLE_KEY: "local-service-key",
  };
  const providerKeyName = `RETELL_TEST_${a.clinic.replaceAll("-", "")}`;
  env[providerKeyName] = "local-retell-key";
  const json = (body, status = 200) => Response.json(body, { status });
  const localFetch = async (input, init) => {
    const request = new Request(input, init),
      url = new URL(request.url);
    assert.equal(request.method, "GET", "playback never mutates provider or database records");
    assert.equal(init.redirect, "error");
    if (url.origin === "https://api.retellai.com") {
      providerCalls++;
      assert.equal(url.pathname, `/v2/get-call/${a.call}`);
      assert.equal(request.headers.get("authorization"), "Bearer local-retell-key");
      if (mode === "revoked_during_fetch") {
        await db.exec("begin; set local role service_role");
        await db.query("select set_config('request.jwt.claims',$1,true)", [
          JSON.stringify({ role: "service_role" }),
        ]);
        await db.query("update profiles set revoked_at=now() where id=$1", [a.profile]);
        await db.exec("commit");
      }
      if (mode === "error") return json({ message: "PRIVATE_PROVIDER_DIAGNOSTIC" }, 500);
      return json({
        call_id: mode === "wrong_call" ? b.call : a.call,
        agent_id: mode === "wrong_agent" ? `agent-${b.clinic}` : `agent-${a.clinic}`,
        opt_in_signed_url: mode !== "unsigned",
        recording_url:
          mode === "missing_recording"
            ? undefined
            : mode === "bare_url"
              ? "https://media.example/recording.wav"
              : mode === "http_url"
                ? "http://media.example/recording.wav?signature=test"
                : `https://media.example/recording.wav?signature=local-${providerCalls}`,
      });
    }
    assert.equal(url.origin, origin, "no external network in tests");
    const actor = tokens[request.headers.get("authorization")?.replace(/^Bearer /, "")];
    if (url.pathname === "/auth/v1/user")
      return actor
        ? json({ id: actor, role: "authenticated", aud: "authenticated" })
        : json({ msg: "Invalid token" }, 401);
    const service = request.headers.get("apikey") === env.SUPABASE_SERVICE_ROLE_KEY;
    const table = url.pathname.replace("/rest/v1/", "");
    assert.ok(["profiles", "conversations", "voice_integrations"].includes(table));
    assert.equal(service, table === "voice_integrations", "conversations never use service role");
    const columns = url.searchParams.get("select");
    assert.match(columns, /^[a-z_,]+$/);
    assert.ok(!columns.includes("recording_url"));
    const conditions = [],
      values = [];
    for (const [column, filter] of url.searchParams) {
      if (column === "select") continue;
      assert.ok(["auth_user_id", "id", "clinic_id", "agent_id", "active"].includes(column));
      assert.ok(filter.startsWith("eq."));
      values.push(filter.slice(3));
      conditions.push(`${column}=$${values.length}`);
    }
    await db.exec("begin; set local role " + (service ? "service_role" : "authenticated"));
    await db.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ role: service ? "service_role" : "authenticated", sub: actor }),
    ]);
    try {
      const rows = (
        await db.query(`select ${columns} from ${table} where ${conditions.join(" and ")}`, values)
      ).rows;
      return json(rows);
    } catch (error) {
      return json({ code: error.code, message: "PRIVATE_DATABASE_DIAGNOSTIC" }, 403);
    } finally {
      await db.exec("rollback");
    }
  };
  const handler = createRecordingAccessFunction((name) => env[name], localFetch);
  async function call(token = "owner", body = { conversationId: a.conversation }, extra = {}) {
    const response = await handler(
      new Request(`${origin}/functions/v1/recording-access`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: portal,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...extra,
        },
        body: JSON.stringify(body),
      }),
    );
    assert.equal(response.headers.get("cache-control"), "no-store");
    const result = await response.json();
    assert.ok(!JSON.stringify(result).includes("PRIVATE_"));
    assert.ok(!JSON.stringify(result).includes("local-retell-key"));
    return { status: response.status, ...result };
  }
  try {
    await loadSql(db, "10_clinic_access_privileges.sql");
    for (const [id, role] of [
      [manager, "manager"],
      [staff, "staff"],
      [unlinked, null],
    ]) {
      await db.query("insert into auth.users(id,email) values($1,$2)", [id, `${id}@example.test`]);
      if (role)
        await db.query(
          "insert into profiles(auth_user_id,clinic_id,full_name,email,role) values($1,$2,$3,$4,$5)",
          [id, a.clinic, role, `${id}@example.test`, role],
        );
    }
    await db.query("update conversations set retell_agent_id=$1,recording_url=$2 where id=$3", [
      `agent-${a.clinic}`,
      "https://media.example/legacy-unsigned.wav",
      a.conversation,
    ]);
    const migration = await readFile(
      new URL("../supabase/migrations/20261004140000_recording_access.sql", import.meta.url),
      "utf8",
    );
    const beforePolicies = (
      await db.query(
        "select * from pg_policies where tablename='conversations' order by policyname",
      )
    ).rows;
    const beforeRows = (await db.query("select * from conversations order by id")).rows;
    await db.exec(migration);
    await db.exec(migration);
    await t.test(
      "migration preserves rows, RLS, policies and service-role access; denies legacy URL reads",
      async () => {
        assert.deepEqual(
          (
            await db.query(
              "select * from pg_policies where tablename='conversations' order by policyname",
            )
          ).rows,
          beforePolicies,
        );
        assert.deepEqual(
          (await db.query("select * from conversations order by id")).rows,
          beforeRows,
        );
        assert.equal(
          (await db.query("select recording_url from conversations where id=$1", [a.conversation]))
            .rows[0].recording_url,
          "https://media.example/legacy-unsigned.wav",
        );
        for (const role of ["anon", "authenticated"]) {
          assert.equal(
            (
              await db.query(
                "select has_column_privilege($1,'conversations','recording_url','SELECT') allowed",
                [role],
              )
            ).rows[0].allowed,
            false,
          );
        }
        await asUser(db, a.user, async () => {
          await assert.rejects(
            attempt(db, () => db.query("select recording_url from conversations")),
            (e) => e.code === "42501",
          );
          assert.equal((await db.query("select id from conversations")).rows.length, 1);
          assert.equal(
            (await db.query("select id from conversations where clinic_id=$1", [b.clinic])).rows
              .length,
            0,
          );
        });
        await asRole(db, "service_role", { role: "service_role" }, async () => {
          assert.ok(
            (
              await db.query("select recording_url from conversations where id=$1", [
                a.conversation,
              ])
            ).rows[0].recording_url,
          );
        });
      },
    );
    await t.test(
      "Owner, Manager and Staff of the correct clinic receive fresh signed access",
      async () => {
        const urls = [];
        for (const token of ["owner", "manager", "staff", "owner"]) {
          const result = await call(token);
          assert.equal(result.status, 200);
          urls.push(result.url);
        }
        assert.equal(new Set(urls).size, 4);
      },
    );
    await t.test(
      "foreign clinic and missing conversation fail identically before contacting Retell",
      async () => {
        const count = providerCalls;
        assert.deepEqual(await call("foreign"), await call("owner", { conversationId: uuid(999) }));
        assert.equal((await call("owner", { conversationId: b.conversation })).status, 404);
        assert.equal(providerCalls, count);
      },
    );
    await t.test(
      "missing/invalid authentication and unlinked membership cannot access playback",
      async () => {
        const count = providerCalls;
        assert.equal((await call(null)).status, 401);
        assert.equal((await call("invalid")).status, 401);
        assert.equal((await call("unlinked")).status, 403);
        assert.equal(providerCalls, count);
      },
    );
    await t.test(
      "arbitrary URL, clinic injection, malformed IDs and foreign origins are rejected",
      async () => {
        const count = providerCalls;
        for (const body of [
          { url: "https://media.example" },
          { conversationId: a.conversation, clinic_id: b.clinic },
          { conversationId: "not-an-id" },
          null,
        ])
          assert.equal((await call("owner", body)).status, 400);
        assert.equal(
          (await call("owner", undefined, { origin: "https://foreign.example" })).status,
          403,
        );
        assert.equal(providerCalls, count);
      },
    );
    await t.test(
      "missing recording, unsigned legacy file, wrong provider identity and unsafe URLs fail closed",
      async () => {
        for (mode of [
          "missing_recording",
          "unsigned",
          "wrong_agent",
          "wrong_call",
          "bare_url",
          "http_url",
        ])
          assert.deepEqual(await call(), { status: 404, code: "recording_unavailable" });
        mode = "error";
        assert.deepEqual(await call(), { status: 502, code: "unavailable" });
        mode = "signed";
      },
    );
    await t.test("missing integration or provider credential fails safely", async () => {
      const count = providerCalls;
      const key = env[providerKeyName];
      delete env[providerKeyName];
      assert.equal((await call()).status, 503);
      env[providerKeyName] = key;
      await db.query("update voice_integrations set active=false where clinic_id=$1", [a.clinic]);
      assert.equal((await call()).status, 404);
      await db.query("update voice_integrations set active=true where clinic_id=$1", [a.clinic]);
      assert.equal(providerCalls, count);
    });
    await t.test("missing saved call identifier fails without using a stored URL", async () => {
      const count = providerCalls;
      await db.query("update conversations set retell_call_id=null where id=$1", [a.conversation]);
      assert.equal((await call()).status, 404);
      await db.query("update conversations set retell_call_id=$1 where id=$2", [
        a.call,
        a.conversation,
      ]);
      assert.equal(providerCalls, count);
    });
    await t.test(
      "a narrower database conversation policy is respected for same-clinic users",
      async () => {
        const count = providerCalls;
        await db.exec(
          "create policy recording_test_restriction on conversations as restrictive for select to authenticated using (false)",
        );
        assert.equal((await call()).status, 404);
        assert.equal(providerCalls, count);
        await db.exec("drop policy recording_test_restriction on conversations");
      },
    );
    await t.test(
      "revocation during provider lookup prevents returning the credential",
      async () => {
        mode = "revoked_during_fetch";
        assert.equal((await call()).status, 404);
        mode = "signed";
        const count = providerCalls;
        assert.equal((await call()).status, 403);
        assert.equal(providerCalls, count);
      },
    );
  } finally {
    await db.close();
  }
});
