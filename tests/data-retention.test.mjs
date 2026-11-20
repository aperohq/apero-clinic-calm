import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { createClinicDatabase, tenants, uuid, asUser } from "./helpers/clinic-database.mjs";
import {
  processProviderJob,
  runProviderBatch,
  fingerprint,
} from "../supabase/functions/retention-worker/core.mjs";
const [a, b] = tenants;
const migrations = [
  "20261006160000_data_retention.sql",
  "20261006161000_retention_lifecycle.sql",
  "20261031120000_demo_call_sessions.sql",
  "20261120100000_note_author_deletion.sql",
  "20261120102000_sessionless_retention_revocation.sql",
  "20261120103000_demo_offboarding.sql",
  "20261120111000_stale_appointment_retention.sql",
];
const value = async (db, sql, args = []) => (await db.query(sql, args)).rows[0];
const run = async (db, clinic = a.clinic, dry = false, batch = 100) =>
  (await value(db, "select public.retention_run_clinic($1,$2,$3) as result", [clinic, dry, batch]))
    .result;
async function fixture() {
  const db = await createClinicDatabase({ team: true });
  for (const file of migrations)
    await db.exec(
      await readFile(new URL("../supabase/migrations/" + file, import.meta.url), "utf8"),
    );
  return db;
}
async function approve(db) {
  await db.exec(
    "update public.retention_control set mode='enabled',approved_at=now(),restore_ledger_ready=true",
  );
}
async function ack(db) {
  await db.exec("update public.retention_deletion_ledger set durable_at=now()");
}
async function oldCall(db, id = uuid(501), clinic = a.clinic, age = 40) {
  await db.query(
    "insert into conversations(id,clinic_id,retell_call_id,retell_agent_id,started_at,transcript,summary,caller_phone,title,recording_url) values($1,$2,$3,'agent_fixture',now()-make_interval(days=>$4),$5::jsonb,'SENSITIVE SUMMARY','SENSITIVE PHONE','SENSITIVE TITLE','https://example.test/recording')",
    [
      id,
      clinic,
      "call_" + id.replaceAll("-", ""),
      age,
      JSON.stringify([{ text: "SENSITIVE TRANSCRIPT" }]),
    ],
  );
  return id;
}
test("Retention SQL uses isolated PostgreSQL and two synthetic clinics", async (t) => {
  const db = await fixture();
  try {
    await t.test(
      "policy JSON defaults match SQL and approval/restore gates cannot be bypassed",
      async () => {
        const policy = JSON.parse(
          await readFile(new URL("../operations/retention/policy.json", import.meta.url), "utf8"),
        );
        assert.deepEqual(
          (await value(db, "select defaults from retention_control")).defaults,
          policy.defaults,
        );
        await assert.rejects(db.exec("update retention_control set mode='enabled'"));
        await assert.rejects(db.exec("update retention_control set overrides='{}'"));
      },
    );
    const old = await oldCall(db);
    const foreign = await oldCall(db, uuid(502), b.clinic);
    const recent = await oldCall(db, uuid(503), a.clinic, 1);
    await t.test(
      "default and explicit dry-run never modify patient data or queue provider deletes",
      async () => {
        const before = (await db.query("select * from conversations order by id")).rows;
        const r = await run(db, a.clinic, false);
        assert.equal(r.mode, "dry_run");
        assert.deepEqual((await db.query("select * from conversations order by id")).rows, before);
        assert.equal((await value(db, "select count(*)::int n from retention_provider_jobs")).n, 0);
        assert.equal(
          (await value(db, "select count(*)::int n from retention_deletion_ledger")).n,
          0,
        );
      },
    );
    await approve(db);
    await t.test(
      "future appointment survives, recent call survives, foreign clinic survives",
      async () => {
        await run(db);
        await ack(db);
        await run(db);
        assert.ok(
          (await value(db, "select id from appointments where id=$1", [a.appointment]))?.id,
        );
        assert.ok(
          (await value(db, "select transcript from conversations where id=$1", [recent]))
            .transcript,
        );
        assert.ok(
          (await value(db, "select transcript from conversations where id=$1", [foreign]))
            .transcript,
        );
      },
    );
    await t.test(
      "expired transcript, summary, title, phone and legacy URL are all removed",
      async () => {
        const c = await value(
          db,
          "select transcript,summary,title,caller_phone,recording_url from conversations where id=$1",
          [old],
        );
        assert.deepEqual(c, {
          transcript: null,
          summary: null,
          title: "Call content removed",
          caller_phone: null,
          recording_url: null,
        });
        assert.equal(
          (
            await value(
              db,
              "select count(*)::int n from retention_provider_jobs where clinic_id=$1",
              [a.clinic],
            )
          ).n,
          1,
        );
      },
    );
    await t.test(
      "durable independent tombstone receipt is required before provider claims",
      async () => {
        await db.exec(
          "update retention_deletion_ledger set durable_at=null where resource_table='retell_call'",
        );
        assert.equal(
          (await db.query("select * from retention_claim($1,10)", [a.clinic])).rows.length,
          0,
        );
        await ack(db);
        assert.equal(
          (await db.query("select * from retention_claim($1,10)", [a.clinic])).rows.length,
          1,
        );
      },
    );
    await t.test("late webhook cannot resurrect speech content", async () => {
      await db.query(
        "update conversations set transcript=$2::jsonb,summary='SENSITIVE' where id=$1",
        [old, JSON.stringify([{ text: "RESURRECTED" }])],
      );
      assert.equal(
        (await value(db, "select transcript from conversations where id=$1", [old])).transcript,
        null,
      );
    });
    await t.test("open requests survive; new Closed clock and reopening are handled", async () => {
      await db.query("update voice_requests set created_at=now()-interval '200 days' where id=$1", [
        a.request,
      ]);
      await run(db);
      assert.ok(await value(db, "select id from voice_requests where id=$1", [a.request]));
      await db.query("update voice_requests set status='Closed' where id=$1", [a.request]);
      assert.ok(
        (await value(db, "select closed_at from voice_requests where id=$1", [a.request]))
          .closed_at,
      );
      await db.query("update voice_requests set status='Open' where id=$1", [a.request]);
      assert.equal(
        (await value(db, "select closed_at from voice_requests where id=$1", [a.request]))
          .closed_at,
        null,
      );
    });
    await t.test("old Closed request expires, recent Closed request survives", async () => {
      // Remove clock trigger only inside fixture to simulate historic closure times.
      await db.exec("alter table voice_requests disable trigger retention_closed_clock");
      await db.query(
        "insert into voice_requests(id,clinic_id,request_key,kind,phone,reason,status,closed_at) values($1,$2,'old-closed','message','SENSITIVE','SENSITIVE','Closed',now()-interval '100 days')",
        [uuid(510), a.clinic],
      );
      await db.exec("alter table voice_requests enable trigger retention_closed_clock");
      await db.query(
        "insert into voice_requests(id,clinic_id,request_key,kind,phone,reason,status) values($1,$2,'new-closed','message','SENSITIVE','SENSITIVE','Closed')",
        [uuid(511), a.clinic],
      );
      await run(db);
      await ack(db);
      await run(db);
      assert.equal(
        await value(db, "select id from voice_requests where id=$1", [uuid(510)]),
        undefined,
      );
      assert.ok(await value(db, "select id from voice_requests where id=$1", [uuid(511)]));
    });
    await t.test(
      "manual client deletion and erasure refuse active work and foreign scope",
      async () => {
        await assert.rejects(
          db.query("delete from clients where id=$1", [a.client]),
          (e) => e.code === "23503",
        );
        await assert.rejects(
          db.query("select retention_erase_client($1,$2,false)", [a.clinic, a.client]),
        );
        await assert.rejects(
          db.query("select retention_erase_client($1,$2,true)", [a.clinic, b.client]),
        );
        assert.equal(
          (await value(db, "select client_id from appointments where id=$1", [a.appointment]))
            .client_id,
          a.client,
        );
      },
    );
    await t.test("all browser roles lack retention tables and RPC authority", async () => {
      await asUser(db, a.user, async () => {
        await db.exec("savepoint deny");
        await assert.rejects(
          db.query("select retention_run_clinic($1,false,100)", [b.clinic]),
          (e) => e.code === "42501",
        );
        await db.exec("rollback to savepoint deny");
        await assert.rejects(
          db.exec("select * from retention_deletion_ledger"),
          (e) => e.code === "42501",
        );
      });
    });
    await t.test(
      "bounded batches and idempotency with explicit dry-run in enabled mode",
      async () => {
        for (let n = 520; n < 526; n++) await oldCall(db, uuid(n));
        const before = (
          await db.query("select transcript from conversations where id in ($1,$2)", [
            uuid(520),
            uuid(521),
          ])
        ).rows;
        await run(db, a.clinic, true, 2);
        assert.deepEqual(
          (
            await db.query("select transcript from conversations where id in ($1,$2)", [
              uuid(520),
              uuid(521),
            ])
          ).rows,
          before,
        );
        await run(db, a.clinic, false, 2);
        await ack(db);
        await run(db, a.clinic, false, 2);
        assert.equal(
          (
            await value(
              db,
              "select count(*)::int n from conversations where id between $1 and $2 and transcript is null",
              [uuid(520), uuid(525)],
            )
          ).n,
          2,
        );
        for (let n = 0; n < 8; n++) {
          await run(db, a.clinic, false, 2);
          await ack(db);
        }
        const first = (await value(db, "select count(*)::int n from retention_provider_jobs")).n;
        await run(db);
        assert.equal(
          (await value(db, "select count(*)::int n from retention_provider_jobs")).n,
          first,
        );
        await assert.rejects(run(db, a.clinic, false, 501));
      },
    );
    await t.test("database category failure rolls back changes and recovers", async () => {
      await db.query(
        "insert into notifications(id,clinic_id,title,created_at) values($1,$2,'SENSITIVE',now()-interval '40 days')",
        [uuid(550), a.clinic],
      );
      await run(db);
      await ack(db);
      await db.exec(
        "create function reject_retention_test() returns trigger language plpgsql as $$ begin raise exception 'SENSITIVE ERROR';end $$; create trigger reject_retention_test before delete on notifications for each row execute function reject_retention_test()",
      );
      const r = await run(db);
      assert.equal(r.categories.notification.state, "failure");
      assert.ok(await value(db, "select id from notifications where id=$1", [uuid(550)]));
      assert.equal(
        (
          await value(
            db,
            "select failure_category from retention_runs where category='notification' and state='failure' order by started_at desc limit 1",
          )
        ).failure_category,
        "database_error",
      );
      await db.exec("drop trigger reject_retention_test on notifications");
      await run(db);
      assert.equal(
        await value(db, "select id from notifications where id=$1", [uuid(550)]),
        undefined,
      );
    });
    await t.test(
      "restore replay strips restored content and does not touch foreign clinic",
      async () => {
        const foreignBefore = (
          await db.query("select * from conversations where clinic_id=$1", [b.clinic])
        ).rows;
        await db.exec("alter table conversations disable trigger retention_conversation_guard");
        await db.query("update conversations set transcript='[]',summary='RESTORED' where id=$1", [
          old,
        ]);
        await db.exec("alter table conversations enable trigger retention_conversation_guard");
        await db.query("select retention_replay_ledger($1)", [a.clinic]);
        assert.equal(
          (await value(db, "select summary from conversations where id=$1", [old])).summary,
          null,
        );
        assert.deepEqual(
          (await db.query("select * from conversations where clinic_id=$1", [b.clinic])).rows,
          foreignBefore,
        );
      },
    );
    await t.test("legal hold and pause prevent cleanup and provider claims", async () => {
      await db.query("insert into clinic_retention(clinic_id,legal_hold) values($1,true)", [
        a.clinic,
      ]);
      assert.equal((await run(db)).state, "held");
      assert.equal(
        (await db.query("select * from retention_claim($1,20)", [a.clinic])).rows.length,
        0,
      );
      await db.query(
        "update clinic_retention set legal_hold=false,paused=true where clinic_id=$1",
        [a.clinic],
      );
      assert.equal((await run(db)).state, "held");
      await db.query("update clinic_retention set paused=false where clinic_id=$1", [a.clinic]);
    });
    await t.test("offboarding is scope-safe and active work blocks purge", async () => {
      await db.exec("select set_config('request.jwt.claims','{}',false)");
      await db.query(
        "insert into demo_call_sessions(request_id,clinic_id,auth_user_id,ended) values($1,$2,$3,true)",
        [uuid(559), a.clinic, a.user],
      );
      await db.query("select retention_begin_offboarding($1)", [a.clinic]);
      assert.equal(
        (await value(db, "select active from voice_integrations where clinic_id=$1", [a.clinic]))
          .active,
        false,
      );
      assert.equal(
        (await value(db, "select active from voice_integrations where clinic_id=$1", [b.clinic]))
          .active,
        true,
      );
      await db.query(
        "update clinic_offboarding set grace_until=now()-interval '1 day',telephony_stopped_verified=true,provider_inventory_verified=true where clinic_id=$1",
        [a.clinic],
      );
      await assert.rejects(db.query("select retention_offboard_batch($1,false,100)", [a.clinic]));
      assert.ok(await value(db, "select id from clinics where id=$1", [b.clinic]));
    });
    await t.test(
      "inactive contact is anonymized, identifier shell preserves historical relations",
      async () => {
        await db.query(
          "insert into clients(id,clinic_id,full_name,phone,email,notes,created_at,updated_at) values($1,$2,'SENSITIVE','SENSITIVE','SENSITIVE','SENSITIVE',now()-interval '800 days',now()-interval '800 days')",
          [uuid(560), b.clinic],
        );
        await run(db, b.clinic);
        await ack(db);
        await run(db, b.clinic);
        assert.deepEqual(
          await value(db, "select full_name,phone,email,notes from clients where id=$1", [
            uuid(560),
          ]),
          { full_name: "Removed patient", phone: "", email: null, notes: null },
        );
      },
    );
    await t.test(
      "expired terminal and stale Booked appointments delete after custody acknowledgement",
      async () => {
        await db.query(
          "insert into appointments(id,clinic_id,service,start_time,end_time,status,created_at,updated_at) values($1,$2,'Consultation',now()-interval '800 days',now()-interval '799 days','Cancelled',now()-interval '800 days',now()-interval '799 days')",
          [uuid(561), b.clinic],
        );
        await db.query(
          "insert into appointments(id,clinic_id,service,start_time,end_time,status,created_at,updated_at) values($1,$2,'Consultation',now()-interval '800 days',now()-interval '799 days','Booked',now()-interval '800 days',now()-interval '799 days')",
          [uuid(562), b.clinic],
        );
        await run(db, b.clinic);
        await ack(db);
        await run(db, b.clinic);
        assert.equal(
          await value(db, "select id from appointments where id=$1", [uuid(561)]),
          undefined,
        );
        assert.equal(
          await value(db, "select id from appointments where id=$1", [uuid(562)]),
          undefined,
        );
      },
    );
    await t.test(
      "leased jobs cannot be claimed twice or acknowledged by foreign clinic",
      async () => {
        await db.exec(
          "update retention_provider_jobs set lease_until=null,state='pending',next_attempt_at=now()",
        );
        await ack(db);
        const jobs = (await db.query("select * from retention_claim($1,50)", [a.clinic])).rows;
        assert.ok(jobs.length > 0);
        assert.equal(
          (await db.query("select * from retention_claim($1,50)", [a.clinic])).rows.length,
          0,
        );
        assert.equal(
          (
            await value(db, "select retention_finish($1,$2,$3,true) as result", [
              b.clinic,
              jobs[0].id,
              jobs[0].lease_token,
            ])
          ).result,
          false,
        );
      },
    );
    await t.test(
      "offboarding finishes in bounded FK order and foreign clinic remains intact",
      async () => {
        await db.query(
          "update appointments set status='Cancelled',start_time=now()-interval '2 days',end_time=now()-interval '1 day' where clinic_id=$1",
          [a.clinic],
        );
        await db.query("update voice_requests set status='Closed' where clinic_id=$1", [a.clinic]);
        await db.query(
          "update clinic_offboarding set secrets_revoked_verified=true where clinic_id=$1",
          [a.clinic],
        );
        await db.query("select retention_offboard_batch($1,false,2)", [a.clinic]);
        await ack(db);
        await db.query("select retention_offboard_batch($1,false,2)", [a.clinic]);
        // Disposable provider/Auth fixtures only, simulating worker completion.
        await db.query("delete from auth.users where id=$1", [a.user]);
        let last;
        for (let i = 0; i < 80; i++) {
          await db.query(
            "update retention_provider_jobs set state='succeeded',completed_at=now() where clinic_id=$1",
            [a.clinic],
          );
          await ack(db);
          last = (
            await value(db, "select retention_offboard_batch($1,false,2) as result", [a.clinic])
          ).result;
          if (last.state === "complete") break;
        }
        assert.equal(last.state, "complete");
        assert.equal(await value(db, "select id from clinics where id=$1", [a.clinic]), undefined);
        assert.ok(await value(db, "select id from clinics where id=$1", [b.clinic]));
      },
    );
    await t.test("audit contains safe categories/counts, no content or recording URL", async () => {
      const audit = JSON.stringify((await db.query("select * from retention_runs")).rows);
      assert.ok(!/SENSITIVE|https:|TRANSCRIPT|PHONE|TITLE/.test(audit));
      assert.equal(
        (
          await value(
            db,
            "select count(*)::int n from retention_deletion_ledger where resource_table='conversations'",
          )
        ).n > 0,
        true,
      );
    });
  } finally {
    await db.close();
  }
});

function mockDb({
  jobs = [],
  mode = "enabled",
  mappingClinic = a.clinic,
  rpcFailure,
  finishFailure = false,
} = {}) {
  const calls = [];
  const db = {
    calls,
    from(table) {
      const q = {
        select() {
          return q;
        },
        eq() {
          return q;
        },
        single: async () => ({ data: { mode, approved_at: "approved" } }),
        maybeSingle: async () => ({
          data: table === "profiles" ? { clinic_id: mappingClinic, revoked_at: "revoked" } : null,
        }),
        then(resolve) {
          return Promise.resolve({
            data: [
              {
                clinic_id: mappingClinic,
                agent_id: "agent_fixture",
                secret_env_name: "RETELL_FIXTURE",
              },
            ],
          }).then(resolve);
        },
      };
      return q;
    },
    async rpc(name, args) {
      calls.push({ name, args });
      return name === rpcFailure || (finishFailure && name === "retention_finish")
        ? { error: new Error("SENSITIVE") }
        : { data: name === "retention_claim" ? jobs : true };
    },
  };
  return db;
}
const job = {
  id: uuid(800),
  lease_token: uuid(801),
  clinic_id: a.clinic,
  provider: "retell",
  target_key: "call_fixture",
  agent_id: "agent_fixture",
};
const env = () => "SENSITIVE_API_SECRET";
test("provider dry-run makes zero provider calls", async () => {
  let external = 0;
  const r = await runProviderBatch(
    mockDb({ mode: "dry_run", jobs: [job] }),
    env,
    a.clinic,
    async () => {
      external++;
    },
  );
  assert.equal(external, 0);
  assert.equal(r.processed, 0);
});
test("provider deletion verifies agent, persists receipt, DELETE 204 then verifies 404", async () => {
  const methods = [];
  let gets = 0;
  const db = mockDb();
  const r = await processProviderJob(db, env, a.clinic, job, async (_url, opt) => {
    methods.push(opt.method);
    if (opt.method === "DELETE") return new Response(null, { status: 204 });
    return ++gets === 1
      ? Response.json({ call_id: job.target_key, agent_id: job.agent_id, call_status: "ended" })
      : new Response(null, { status: 404 });
  });
  assert.equal(r.success, true);
  assert.deepEqual(methods, ["GET", "DELETE", "GET"]);
  assert.equal(db.calls[0].name, "retention_verify_provider");
});
test("provider failure never reports deletion success; raw error discarded", async () => {
  const r = await processProviderJob(mockDb(), env, a.clinic, job, async () => {
    throw new Error("SENSITIVE_API_SECRET transcript recording URL");
  });
  assert.deepEqual(r, { success: false, failure: "provider_error" });
});
test("wrong clinic, wrong agent, ongoing call and missing mapping fail closed", async () => {
  let deletes = 0;
  for (const db of [mockDb({ mappingClinic: b.clinic }), mockDb()]) {
    const r = await processProviderJob(db, env, a.clinic, job, async (_url, opt) => {
      if (opt.method === "DELETE") deletes++;
      return Response.json({
        call_id: job.target_key,
        agent_id: "agent_foreign",
        call_status: "ongoing",
      });
    });
    assert.equal(r.success, false);
  }
  assert.equal(deletes, 0);
});
test("404 requires prior durable ownership verification with the same key", async () => {
  const transport = async () => new Response(null, { status: 404 });
  assert.equal((await processProviderJob(mockDb(), env, a.clinic, job, transport)).success, false);
  assert.equal(
    (
      await processProviderJob(
        mockDb(),
        env,
        a.clinic,
        {
          ...job,
          ownership_verified_at: "verified",
          verified_key_fingerprint: await fingerprint(env()),
        },
        transport,
      )
    ).success,
    true,
  );
  assert.equal(
    (
      await processProviderJob(
        mockDb(),
        env,
        a.clinic,
        { ...job, ownership_verified_at: "verified", verified_key_fingerprint: "wrong" },
        transport,
      )
    ).success,
    false,
  );
});
test("failed DB receipt prevents external DELETE; failed DB acknowledgement is recoverable", async () => {
  let deletes = 0;
  const transport = async (_url, opt) => {
    if (opt.method === "DELETE") {
      deletes++;
      return new Response(null, { status: 204 });
    }
    return Response.json({ call_id: job.target_key, agent_id: job.agent_id, call_status: "ended" });
  };
  assert.equal(
    (
      await processProviderJob(
        mockDb({ rpcFailure: "retention_verify_provider" }),
        env,
        a.clinic,
        job,
        transport,
      )
    ).failure,
    "database_error",
  );
  assert.equal(deletes, 0);
  const r = await runProviderBatch(
    mockDb({ jobs: [job], finishFailure: true }),
    env,
    a.clinic,
    transport,
  );
  assert.equal(r.succeeded, 0);
  assert.equal(r.failed, 1);
});

test("preserved activity prevents prematurely expiring contacts after call row deletion", async () => {
  const db = await fixture();
  try {
    await approve(db);
    const id = uuid(900);
    await db.query(
      "insert into clients(id,clinic_id,full_name,phone,created_at,updated_at) values($1,$2,'SENSITIVE','96500000',now()-interval '800 days',now()-interval '800 days')",
      [id, b.clinic],
    );
    const call = await oldCall(db, uuid(901), b.clinic, 400);
    await db.query("update conversations set client_id=$1 where id=$2", [id, call]);
    await db.query("delete from conversations where id=$1", [call]);
    assert.equal(
      (
        await value(
          db,
          "select count(*)::int n from retention_candidates where category='client_contact' and resource_key=$1",
          [id],
        )
      ).n,
      0,
    );
  } finally {
    await db.close();
  }
});
test("manual historical erasure waits for custody and keeps appointment relationships", async () => {
  const db = await fixture();
  try {
    await approve(db);
    const id = uuid(910),
      appointment = uuid(911);
    await db.query(
      "insert into clients(id,clinic_id,full_name,phone,notes) values($1,$2,'SENSITIVE','96522222','SENSITIVE')",
      [id, b.clinic],
    );
    await db.query(
      "insert into appointments(id,clinic_id,client_id,service,start_time,end_time,status,notes) values($1,$2,$3,'Consultation',now()-interval '2 days',now()-interval '1 day','Completed','SENSITIVE')",
      [appointment, b.clinic, id],
    );
    assert.equal(
      (await value(db, "select retention_erase_client($1,$2,false) result", [b.clinic, id])).result
        .mode,
      "awaiting_durable_ledger",
    );
    assert.equal(
      (await value(db, "select full_name from clients where id=$1", [id])).full_name,
      "SENSITIVE",
    );
    await ack(db);
    assert.equal(
      (await value(db, "select retention_erase_client($1,$2,false) result", [b.clinic, id])).result
        .mode,
      "enabled",
    );
    assert.deepEqual(
      await value(db, "select client_id,notes from appointments where id=$1", [appointment]),
      { client_id: id, notes: null },
    );
    assert.equal(
      (await value(db, "select full_name from clients where id=$1", [id])).full_name,
      "Removed patient",
    );
  } finally {
    await db.close();
  }
});
test("native provider expiry needs a successfully verified exclusive agent", async () => {
  const methods = [];
  const r = await processProviderJob(mockDb(), env, a.clinic, job, async (url, opt) => {
    methods.push(opt.method);
    return url.includes("/get-agent/")
      ? Response.json({ agent_id: job.agent_id })
      : new Response(null, { status: 404 });
  });
  assert.deepEqual(r, { success: true, already_absent: true });
  assert.deepEqual(methods, ["GET", "GET"]);
});
test("staff expiry and provider receipt pruning have bounded relationship checks", async () => {
  const db = await fixture();
  try {
    await approve(db);
    const oldStaff = uuid(920),
      newStaff = uuid(921),
      absence = uuid(922),
      receipt = uuid(923);
    await db.exec("alter table staff disable trigger retention_staff_clock");
    await db.query(
      "insert into staff(id,clinic_id,full_name,specialty,active,phone,email,deactivated_at) values($1,$2,'SENSITIVE','General',false,'SENSITIVE','SENSITIVE',now()-interval '800 days'),($3,$2,'SENSITIVE','General',false,'SENSITIVE','SENSITIVE',now()-interval '200 days')",
      [oldStaff, b.clinic, newStaff],
    );
    await db.exec("alter table staff enable trigger retention_staff_clock");
    await db.query(
      "insert into staff_time_off(id,clinic_id,staff_id,start_time,end_time) values($1,$2,$3,now()-interval '810 days',now()-interval '805 days')",
      [absence, b.clinic, oldStaff],
    );
    await db.query(
      "insert into retention_provider_jobs(id,clinic_id,provider,target_key,state,completed_at) values($1,$2,'retell','call_orphan_receipt','succeeded',now()-interval '400 days')",
      [receipt, b.clinic],
    );
    await run(db, b.clinic);
    await ack(db);
    await run(db, b.clinic);
    await ack(db);
    await run(db, b.clinic);
    assert.equal(await value(db, "select id from staff where id=$1", [oldStaff]), undefined);
    assert.deepEqual(await value(db, "select phone,email from staff where id=$1", [newStaff]), {
      phone: null,
      email: null,
    });
    assert.equal(
      await value(db, "select id from staff_time_off where id=$1", [absence]),
      undefined,
    );
    assert.equal(
      await value(db, "select id from retention_provider_jobs where id=$1", [receipt]),
      undefined,
    );
  } finally {
    await db.close();
  }
});
test("Auth hard deletion preserves patient data and verifies a missing user", async () => {
  const db = mockDb();
  let gets = 0;
  let hardDelete = false;
  db.auth = {
    admin: {
      getUserById: async () =>
        ++gets === 1 ? { data: { user: { id: uuid(930) } } } : { error: { status: 404 } },
      deleteUser: async (id, soft) => {
        assert.equal(id, uuid(930));
        hardDelete = soft === false;
        return { error: null };
      },
    },
  };
  const result = await processProviderJob(db, env, a.clinic, {
    ...job,
    provider: "supabase_auth",
    target_key: uuid(930),
  });
  assert.equal(result.success, true);
  assert.equal(hardDelete, true);
  assert.equal(gets, 2);
  assert.equal(db.calls[0].name, "retention_verify_provider");
});
