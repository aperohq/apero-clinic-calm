import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  createClinicDatabase,
  tenants,
  asUser,
  asRole,
  attempt,
  uuid,
} from "./helpers/clinic-database.mjs";
const db = await createClinicDatabase({ appointments: true, team: true });
const [a, b] = tenants;
let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log("PASS", name);
}
try {
  await db.exec(await readFile("supabase/migrations/20261006160000_data_retention.sql", "utf8"));
  await db.exec(
    await readFile("supabase/migrations/20261122120000_integration_system.sql", "utf8"),
  );
  await db.exec(
    await readFile("supabase/migrations/20261123210000_calendar_connection_lifecycle.sql", "utf8"),
  );
  await db.query("select set_config('request.jwt.claims',$1,false)", [
    JSON.stringify({ role: "service_role" }),
  ]);
  let key, raw;
  await test("owner key creation, hash-only storage and scoped metadata", async () => {
    await asUser(db, a.user, async () => {
      const { rows } = await db.query(
        "select integration_create_key('Synthetic',array['appointments:read','appointments:write','availability:read']) value",
      );
      assert.match(rows[0].value.key, /^apero_[a-f0-9]{64}$/);
      const dashboard = (await db.query("select integration_dashboard() value")).rows[0].value;
      assert.equal(dashboard.keys.length, 1);
      assert.equal(JSON.stringify(dashboard).includes(rows[0].value.key), false);
      await assert.rejects(
        () => attempt(db, () => db.query("select key_hash from integration_keys")),
        /permission denied/,
      );
    });
    // asUser intentionally rolls back; create a fixture in a committed auth context below.
    await db.exec("begin;set local role authenticated");
    await db.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ role: "authenticated", sub: a.user }),
    ]);
    const data = (
      await db.query(
        "select integration_create_key('Synthetic',array['appointments:read','appointments:write','availability:read']) value",
      )
    ).rows[0].value;
    key = data.id;
    raw = data.key;
    await db.exec("commit");
    assert.equal(
      (await db.query("select count(*)::int n from integration_keys where key_hash=$1", [raw]))
        .rows[0].n,
      0,
    );
  });
  await test("cross-clinic key lifecycle cannot affect another clinic", async () => {
    await asUser(db, b.user, async () => {
      assert.equal(
        (await db.query("select integration_dashboard() value")).rows[0].value.keys.length,
        0,
      );
      await assert.rejects(
        () => attempt(db, () => db.query("select integration_revoke_key($1)", [key])),
        /Key not found/,
      );
      await assert.rejects(
        () =>
          attempt(db, () =>
            db.query("select integration_create_key('x',array['appointments:write'],$1)", [key]),
          ),
        /Key not found/,
      );
    });
  });
  await test("staff and revoked owners cannot manage integration credentials", async () => {
    await db.query("update profiles set role='staff' where id=$1", [b.profile]);
    await asUser(db, b.user, async () => {
      await assert.rejects(
        () => attempt(db, () => db.query("select integration_dashboard()")),
        /Not authorized/,
      );
    });
    await db.query("update profiles set role='owner',revoked_at=now() where id=$1", [b.profile]);
    await asUser(db, b.user, async () => {
      await assert.rejects(
        () =>
          attempt(db, () =>
            db.query("select integration_create_key('x',array['availability:read'])"),
          ),
        /Not authorized/,
      );
    });
    await db.query("update profiles set revoked_at=null where id=$1", [b.profile]);
  });
  await test("anonymous and browser roles denied all internal tables and worker RPCs", async () => {
    for (const role of ["anon", "authenticated"])
      await asRole(db, role, { role, sub: a.user }, async () => {
        for (const table of [
          "integration_keys",
          "calendar_connections",
          "integration_oauth_states",
          "calendar_busy_intervals",
          "calendar_event_links",
          "integration_jobs",
          "integration_requests",
          "integration_audit",
        ]) {
          await assert.rejects(
            () => attempt(db, () => db.query(`select * from ${table}`)),
            /permission denied/,
          );
          await assert.rejects(
            () => attempt(db, () => db.query(`truncate ${table} cascade`)),
            /permission denied/,
          );
        }
        await assert.rejects(
          () => attempt(db, () => db.query("select integration_claim()")),
          /permission denied/,
        );
        await assert.rejects(
          () =>
            attempt(db, () => db.query("select integration_authorize('x','appointments:read')")),
          /permission denied/,
        );
      });
  });
  await test("API key authentication, expiration, scope denial and atomic rate budget", async () => {
    await asRole(db, "service_role", { role: "service_role" }, async () => {
      for (let i = 0; i < 60; i++)
        assert.equal(
          (
            await db.query(
              "select integration_authorize(encode(digest($1,'sha256'),'hex'),'appointments:read') value",
              [raw],
            )
          ).rows[0].value.clinic_id,
          a.clinic,
        );
      assert.equal(
        (
          await db.query(
            "select integration_authorize(encode(digest($1,'sha256'),'hex'),'appointments:read') value",
            [raw],
          )
        ).rows[0].value.limited,
        true,
      );
      assert.equal(
        (
          await db.query(
            "select integration_authorize(encode(digest($1,'sha256'),'hex'),'admin') value",
            [raw],
          )
        ).rows[0].value,
        null,
      );
    });
    await db.query("update integration_keys set expires_at=now()-interval '1 second' where id=$1", [
      key,
    ]);
    assert.equal(
      (
        await db.query(
          "select integration_authorize(encode(digest($1,'sha256'),'hex'),'appointments:read') value",
          [raw],
        )
      ).rows[0].value,
      null,
    );
    await db.query("update integration_keys set expires_at=now()+interval '1 day' where id=$1", [
      key,
    ]);
  });
  const c = uuid(800),
    c2 = uuid(801);
  await test("OAuth state and connection saving recheck actual clinic owner", async () => {
    await assert.rejects(
      () =>
        db.query("select integration_start_oauth($1,$2,$3,$4)", [
          a.clinic,
          b.user,
          "fake",
          "verifier",
        ]),
      /Not authorized/,
    );
    await db.query("select integration_start_oauth($1,$2,$3,$4)", [
      a.clinic,
      a.user,
      "fake",
      "verifier",
    ]);
    assert.equal(
      (
        await db.query("delete from integration_oauth_states where state_hash=$1 returning *", [
          "fake",
        ])
      ).rows.length,
      1,
    );
    assert.equal(
      (
        await db.query("delete from integration_oauth_states where state_hash=$1 returning *", [
          "fake",
        ])
      ).rows.length,
      0,
    );
    await assert.rejects(
      () =>
        db.query("select integration_save_connection($1,$2,$3,$4)", [
          c,
          a.clinic,
          b.user,
          "encrypted",
        ]),
      /Not authorized/,
    );
    await db.query("select integration_save_connection($1,$2,$3,$4)", [
      c,
      a.clinic,
      a.user,
      "encrypted",
    ]);
    await db.query("select integration_save_connection($1,$2,$3,$4)", [
      c2,
      b.clinic,
      b.user,
      "encrypted",
    ]);
  });
  await test("repeated OAuth reuses the active account and reconnect preserves history and tenant boundaries", async () => {
    await db.exec("begin");
    try {
      const prepare = async (clinic, actor, account, target = null) =>
        (
          await db.query("select integration_prepare_connection($1,$2,$3,$4) id", [
            clinic,
            actor,
            account,
            target,
          ])
        ).rows[0].id;
      const id = await prepare(a.clinic, a.user, "owner@synthetic.test");
      assert.equal(await prepare(a.clinic, a.user, "owner@synthetic.test"), id);
      await db.query("select integration_save_connection($1,$2,$3,'encrypted-new')", [
        id,
        a.clinic,
        a.user,
      ]);
      assert.equal(
        (
          await db.query(
            "select count(*)::int n from calendar_connections where google_account_id='owner@synthetic.test' and status<>'disconnected'",
          )
        ).rows[0].n,
        1,
      );
      await assert.rejects(
        () => attempt(db, () => prepare(b.clinic, a.user, "owner@synthetic.test")),
        /Not authorized/,
      );
      await assert.rejects(
        () => attempt(db, () => prepare(b.clinic, b.user, "owner@synthetic.test", id)),
        /Connection not found/,
      );
      await assert.rejects(
        () => attempt(db, () => prepare(a.clinic, a.user, "other@synthetic.test", id)),
        /does not match/,
      );
      await db.query("select set_config('request.jwt.claims',$1,true)", [
        JSON.stringify({ role: "authenticated", sub: a.user }),
      ]);
      await db.query("select integration_disconnect($1)", [id]);
      const next = await prepare(a.clinic, a.user, "owner@synthetic.test", id);
      assert.notEqual(next, id);
      assert.equal(await prepare(a.clinic, a.user, "owner@synthetic.test", id), next);
      const history = (
        await db.query("select status,credentials from calendar_connections where id=$1", [id])
      ).rows[0];
      assert.equal(history.status, "disconnected");
      assert.equal(history.credentials, null);
    } finally {
      await db.exec("rollback");
    }
  });
  await test("selection is idempotent, failed initial sync recovers, and scoped work cannot claim another connection", async () => {
    await db.exec("begin");
    try {
      const id = (
        await db.query(
          "select integration_prepare_connection($1,$2,'recovery@synthetic.test') id",
          [a.clinic, a.user],
        )
      ).rows[0].id;
      await db.query("select integration_save_connection($1,$2,$3,'encrypted')", [
        id,
        a.clinic,
        a.user,
      ]);
      await db.query("select set_config('request.jwt.claims',$1,true)", [
        JSON.stringify({ role: "authenticated", sub: a.user }),
      ]);
      await db.query("select integration_select_calendar($1,'primary@synthetic.test',$2)", [
        id,
        a.staff,
      ]);
      const before = (
        await db.query(
          "select generation from integration_jobs where connection_id=$1 and kind='pull'",
          [id],
        )
      ).rows[0].generation;
      await db.query("select integration_select_calendar($1,'primary@synthetic.test',$2)", [
        id,
        a.staff,
      ]);
      assert.equal(
        (
          await db.query(
            "select generation from integration_jobs where connection_id=$1 and kind='pull'",
            [id],
          )
        ).rows[0].generation,
        before,
      );
      await db.query(
        "select integration_select_calendar($1,'acceptance@group.calendar.google.com',$2)",
        [id, a.staff],
      );
      const claim = (await db.query("select integration_claim_connection($1) v", [id])).rows[0].v;
      assert.equal(claim.connection.id, id);
      const attempts = (
        await db.query("select attempts,generation from integration_jobs where id=$1", [
          claim.job.id,
        ])
      ).rows[0];
      await db.query("select integration_retry($1)", [id]);
      assert.deepEqual(
        (
          await db.query("select attempts,generation from integration_jobs where id=$1", [
            claim.job.id,
          ])
        ).rows[0],
        attempts,
      );
      assert.equal(
        (await db.query("select integration_claim_connection($1) v", [id])).rows[0].v,
        null,
      );
      await db.query("select integration_finish($1,$2,$3,'google_http_429',30)", [
        claim.job.id,
        claim.lease,
        claim.job.generation,
      ]);
      assert.equal(
        (await db.query("select status from calendar_connections where id=$1", [id])).rows[0]
          .status,
        "attention",
      );
      await db.query("select integration_retry($1)", [id]);
      const retry = (await db.query("select integration_claim_connection($1) v", [id])).rows[0].v;
      await db.query(
        "select integration_replace_busy($1,$2,now()-interval '1 day',now()+interval '90 days','[]',$3)",
        [id, retry.lease, retry.job.generation],
      );
      await db.query("select integration_finish($1,$2,$3)", [
        retry.job.id,
        retry.lease,
        retry.job.generation,
      ]);
      let state = (
        await db.query(
          "select status,last_synced_at,last_error from calendar_connections where id=$1",
          [id],
        )
      ).rows[0];
      assert.equal(state.status, "connected");
      assert.equal(state.last_error, null);
      await db.query(
        "select integration_select_calendar($1,'acceptance@group.calendar.google.com',$2)",
        [id, a.staff],
      );
      assert.deepEqual(
        (
          await db.query(
            "select status,last_synced_at,last_error from calendar_connections where id=$1",
            [id],
          )
        ).rows[0],
        state,
      );
      await assert.rejects(
        () =>
          attempt(db, () =>
            db.query("select integration_select_calendar($1,'different-calendar',$2)", [
              id,
              a.staff,
            ]),
          ),
        /Disconnect before replacing/,
      );
      await db.query(
        "update calendar_connections set last_synced_at=now()-interval '6 minutes' where id=$1",
        [id],
      );
      assert.equal(
        (
          await db.query(
            "select integration_calendar_open($1,$2,now()+interval '3 days',now()+interval '3 days 45 minutes',null) v",
            [a.clinic, a.staff],
          )
        ).rows[0].v,
        false,
      );
      await db.query("select integration_save_connection($1,$2,$3,'refreshed')", [
        id,
        a.clinic,
        a.user,
      ]);
      assert.equal(
        (
          await db.query(
            "select count(*)::int n from calendar_connections where google_account_id='recovery@synthetic.test'",
          )
        ).rows[0].n,
        1,
      );
      const fresh = (await db.query("select integration_claim_connection($1) v", [id])).rows[0].v;
      await db.query(
        "select integration_replace_busy($1,$2,now()-interval '1 day',now()+interval '90 days','[]',$3)",
        [id, fresh.lease, fresh.job.generation],
      );
      await db.query("select integration_finish($1,$2,$3)", [
        fresh.job.id,
        fresh.lease,
        fresh.job.generation,
      ]);
      assert.equal(
        (
          await db.query(
            "select integration_calendar_open($1,$2,now()+interval '3 days',now()+interval '3 days 45 minutes',null) v",
            [a.clinic, a.staff],
          )
        ).rows[0].v,
        true,
      );
    } finally {
      await db.exec("rollback");
    }
  });
  await test("calendar selection rejects foreign practitioner and cross-clinic connection", async () => {
    await asUser(db, a.user, async () => {
      await assert.rejects(
        () =>
          attempt(db, () =>
            db.query("select integration_select_calendar($1,$2,$3)", [c, "test", b.staff]),
          ),
        /Invalid selection/,
      );
      await assert.rejects(
        () => attempt(db, () => db.query("select integration_disconnect($1)", [c2])),
        /Connection not found/,
      );
    });
    await db.exec("begin;set local role authenticated");
    await db.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ role: "authenticated", sub: a.user }),
    ]);
    await db.query("select integration_select_calendar($1,$2,$3)", [
      c,
      "calendar@example.test",
      a.staff,
    ]);
    await db.exec("commit");
  });
  await test("selected stale calendar blocks shared availability, other clinic unaffected", async () => {
    const open = async (clinic, staff) =>
      (
        await db.query(
          "select integration_calendar_open($1,$2,now()+interval '2 days',now()+interval '2 days 30 minutes',null) v",
          [clinic, staff],
        )
      ).rows[0].v;
    await asRole(db, "service_role", { role: "service_role" }, async () => {
      assert.equal(await open(a.clinic, a.staff), false);
      assert.equal(await open(b.clinic, b.staff), true);
    });
  });
  let claimed;
  await test("lease claim serializes connection work and snapshot rejects stale worker", async () => {
    claimed = (await db.query("select integration_claim() value")).rows[0].value;
    assert.equal(claimed.connection.id, c);
    assert.equal((await db.query("select integration_claim() value")).rows[0].value, null);
    await assert.rejects(
      () =>
        db.query("select integration_replace_busy($1,$2,now(),now()+interval '90 days','[]')", [
          c,
          uuid(999),
        ]),
      /Lease lost/,
    );
    await db.query("select integration_replace_busy($1,$2,now(),now()+interval '90 days',$3)", [
      c,
      claimed.lease,
      JSON.stringify([
        {
          id: "external",
          start: new Date(Date.now() + 86400000).toISOString(),
          end: new Date(Date.now() + 90000000).toISOString(),
        },
      ]),
    ]);
  });
  await test("token refresh leases reject concurrent management and remote event identity survives tombstones", async () => {
    assert.equal(
      (await db.query("select integration_refresh_claim($1,$2,null) v", [c, "encrypted"])).rows[0]
        .v,
      null,
    );
    assert.equal(
      (
        await db.query("select integration_refresh_claim($1,$2,$3) v", [
          c,
          "encrypted",
          claimed.lease,
        ])
      ).rows[0].v,
      claimed.lease,
    );
    const link = async (rotate) =>
      (
        await db.query("select integration_event_link($1,$2,$3,$4) v", [
          c,
          claimed.lease,
          a.appointment,
          rotate,
        ])
      ).rows[0].v;
    const first = await link(false);
    assert.equal(first, "apero" + a.appointment.replaceAll("-", ""));
    const replacement = await link(true);
    assert.equal(replacement, first + "r1");
    assert.equal(await link(false), replacement);
    const apt = (
      await db.query("select start_time,end_time from appointments where id=$1", [a.appointment])
    ).rows[0];
    const events = [
      {
        id: "external",
        start: new Date(Date.now() + 86400000).toISOString(),
        end: new Date(Date.now() + 90000000).toISOString(),
      },
      { id: replacement, start: apt.start_time.toISOString(), end: apt.end_time.toISOString() },
    ];
    await db.query("select integration_replace_busy($1,$2,now(),now()+interval '90 days',$3)", [
      c,
      claimed.lease,
      JSON.stringify(events),
    ]);
    assert.equal(
      (
        await db.query("select integration_calendar_open($1,$2,$3,$4,$5) v", [
          a.clinic,
          a.staff,
          apt.start_time,
          apt.end_time,
          a.appointment,
        ])
      ).rows[0].v,
      true,
    );
    assert.equal(
      (
        await db.query("select integration_calendar_open($1,$2,$3,$4,null) v", [
          a.clinic,
          a.staff,
          apt.start_time,
          apt.end_time,
        ])
      ).rows[0].v,
      false,
    );
  });
  await test("fresh external busy blocks overlap, exclude own event and half-open adjacency", async () => {
    await asRole(db, "service_role", { role: "service_role" }, async () => {
      assert.equal(
        (
          await db.query(
            "select integration_calendar_open($1,$2,now()+interval '24 hours',now()+interval '24 hours 10 minutes',null) v",
            [a.clinic, a.staff],
          )
        ).rows[0].v,
        false,
      );
      assert.equal(
        (
          await db.query(
            "select integration_calendar_open($1,$2,now()+interval '26 hours',now()+interval '26 hours 10 minutes',null) v",
            [a.clinic, a.staff],
          )
        ).rows[0].v,
        true,
      );
    });
  });
  await test("job generation survives webhook/enqueue during processing", async () => {
    await db.query("select integration_enqueue($1,$2,$3)", [
      c,
      claimed.job.kind,
      claimed.job.object_id,
    ]);
    await assert.rejects(
      () =>
        db.query("select integration_replace_busy($1,$2,now(),now()+interval '90 days','[]',$3)", [
          c,
          claimed.lease,
          claimed.job.generation,
        ]),
      /Snapshot invalidated/,
    );
    await db.query("select integration_finish($1,$2,$3)", [
      claimed.job.id,
      claimed.lease,
      claimed.job.generation,
    ]);
    assert.equal(
      (await db.query("select generation from integration_jobs where id=$1", [claimed.job.id])).rows
        .length,
      1,
    );
  });
  await test("webhook token/resource validation and replay acknowledgement", async () => {
    const channel = uuid(850);
    await db.query(
      "update calendar_connections set channel_id=$1,channel_hash='hash',resource_id='resource',channel_expires_at=now()+interval '1 day' where id=$2",
      [channel, c],
    );
    const notify = async (hash, resource, n) =>
      (
        await db.query("select integration_notify($1,$2,$3,$4,'exists') v", [
          channel,
          hash,
          resource,
          n,
        ])
      ).rows[0].v;
    assert.equal(await notify("wrong", "resource", 1), false);
    assert.equal(await notify("hash", "wrong", 1), false);
    assert.equal(await notify("hash", "resource", 10), true);
    assert.equal(await notify("hash", "resource", 9), true);
    assert.equal(
      (await db.query("select message_number from calendar_connections where id=$1", [c])).rows[0]
        .message_number,
      "10",
    );
  });
  await test("cancellations are idempotent and cannot mutate another clinic", async () => {
    await asRole(db, "service_role", { role: "service_role" }, async () => {
      const input = { action: "cancel", appointment_id: a.appointment };
      const call = async (body = input) =>
        (
          await db.query("select integration_mutate($1,$2,$3) v", [
            key,
            "synthetic-cancel",
            JSON.stringify(body),
          ])
        ).rows[0].v;
      const first = await call();
      assert.equal(first.status, "Cancelled");
      assert.deepEqual(await call(), first);
      await assert.rejects(
        () => attempt(db, () => call({ ...input, appointment_id: b.appointment })),
        /Idempotency key reused/,
      );
      await assert.rejects(
        () =>
          attempt(db, () =>
            db.query("select integration_mutate($1,$2,$3)", [
              key,
              "foreign-cancel",
              JSON.stringify({ action: "cancel", appointment_id: b.appointment }),
            ]),
          ),
        /Appointment not found/,
      );
      assert.ok(
        (
          await db.query(
            "select * from integration_jobs where connection_id=$1 and kind='push' and object_id=$2",
            [c, a.appointment],
          )
        ).rows.length,
      );
    });
  });
  await test("dead-letter bounded retries and owner retry recovery", async () => {
    await db.query("update calendar_connections set lease_until=null where id=$1", [c]);
    const claim = (await db.query("select integration_claim() v")).rows[0].v;
    await db.query("update integration_jobs set attempts=8 where id=$1", [claim.job.id]);
    await db.query("select integration_finish($1,$2,$3,$4,3600)", [
      claim.job.id,
      claim.lease,
      claim.job.generation,
      "google_http_503",
    ]);
    assert.ok(
      (await db.query("select dead_at from integration_jobs where id=$1", [claim.job.id])).rows[0]
        .dead_at,
    );
    await asUser(db, a.user, async () => {
      await db.query("select integration_retry($1)", [c]);
      assert.equal((await db.query("select integration_dashboard() v")).rows[0].v.failed_jobs, 0);
    });
  });
  await test("rotation revokes immediately and disconnect purges server credentials", async () => {
    await asUser(db, a.user, async () => {
      await db.query("select integration_create_key('Replacement',array['availability:read'],$1)", [
        key,
      ]);
      await db.query("select integration_disconnect($1)", [c]);
    });
    // Verify persisted disconnection separately; owner wrapper above rolls back.
    await db.exec("begin;set local role authenticated");
    await db.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ role: "authenticated", sub: a.user }),
    ]);
    await db.query("select integration_disconnect($1)", [c]);
    await db.exec("commit");
    const connection = (await db.query("select * from calendar_connections where id=$1", [c]))
      .rows[0];
    assert.equal(connection.credentials, null);
    assert.equal(connection.status, "disconnected");
  });
  await test("approved offboarding revokes keys, purges tokens/jobs and denies new authority", async () => {
    await db.query("insert into clinic_offboarding(clinic_id,state) values($1,'grace')", [
      a.clinic,
    ]);
    assert.equal(
      (
        await db.query(
          "select count(*)::int n from integration_keys where clinic_id=$1 and revoked_at is null",
          [a.clinic],
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await db.query(
          "select count(*)::int n from calendar_connections where clinic_id=$1 and credentials is not null",
          [a.clinic],
        )
      ).rows[0].n,
      0,
    );
    await asUser(db, a.user, async () => {
      await assert.rejects(
        () =>
          attempt(db, () =>
            db.query("select integration_create_key('blocked',array['appointments:write'])"),
          ),
        /Clinic is offboarding/,
      );
    });
  });
  console.log(`PASS ${passed} integration database scenarios`);
} finally {
  await db.close();
}
