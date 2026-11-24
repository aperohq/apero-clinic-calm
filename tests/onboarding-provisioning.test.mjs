import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createClinicDatabase,
  loadSql,
  asUser,
  asRole,
  attempt,
  tenants,
  uuid,
} from "./helpers/clinic-database.mjs";
const key = "synthetic-intake-001";
const payload = (owner = uuid(910)) => ({
  clinic: {
    name: "Apero Test",
    localized_name: "عيادة الاختبار",
    clinic_type: "dental",
    phone: "+96555550123",
    email: "clinic@example.test",
    address: "Synthetic address",
    country: "KW",
    timezone: "Asia/Kuwait",
    receptionist_name: "نور",
    opening_hours: {
      days: Array.from({ length: 7 }, (_, day) => ({
        day,
        periods: day === 5 ? [] : [{ start: "09:00", end: "17:00" }],
      })),
    },
  },
  owner_auth_id: owner,
  owner_name: "Test Owner",
  services: [{ name: "Consultation", duration_minutes: 30 }],
  practitioners: [
    {
      name: "طبيب Test",
      specialty: "Dental",
      services: ["Consultation"],
      availability: Array.from({ length: 7 }, (_, day) => ({
        day,
        start: "09:00",
        end: "17:00",
      })).filter((s) => s.day !== 5),
    },
  ],
  closures: ["2026-12-25"],
  faqs: [{ question: "Hours?", answer: "Published hours" }],
  synthetic: false,
});
async function setup() {
  const db = await createClinicDatabase({ settings: true, appointments: true });
  for (const name of [
    "20261124100000_clinic_onboarding.sql",
    "20261124102000_clinic_activation.sql",
  ])
    await loadSql(db, `../supabase/migrations/${name}`);
  await db.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,$2,now()),($3,$4,now())",
    [uuid(910), "owner910@example.test", uuid(920), "owner920@example.test"],
  );
  return db;
}
const trusted = async (db, fn) => {
  await db.exec("begin; set local role service_role");
  await db.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ role: "service_role" }),
  ]);
  try {
    const result = await fn();
    await db.exec("commit");
    return result;
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
};
const provision = (db, p = payload(), k = key) =>
  db.query("select provision_clinic($1,$2::jsonb) id", [k, JSON.stringify(p)]);
const readiness = (db, id) => db.query("select clinic_activation_readiness($1) r", [id]);
const decide = (db, id, action, approved = false) =>
  db.query("select decide_clinic_lifecycle($1,$2,$3,$4,$5)", [
    id,
    action,
    "Synthetic acceptance evidence",
    "test-consent-v1",
    approved,
  ]);
test("transactional provisioning preserves Unicode, scheduling, owner, idempotency and rollback", async () => {
  const db = await setup();
  try {
    await trusted(db, async () => {
      const id = (await provision(db)).rows[0].id;
      assert.equal((await provision(db)).rows[0].id, id);
      assert.equal(
        (await db.query("select localized_name from clinics where id=$1", [id])).rows[0]
          .localized_name,
        "عيادة الاختبار",
      );
      assert.equal(
        (await db.query("select role from profiles where clinic_id=$1", [id])).rows[0].role,
        "owner",
      );
      assert.equal(
        (await db.query("select count(*)::int n from staff_availability where clinic_id=$1", [id]))
          .rows[0].n,
        6,
      );
      assert.equal(
        (await db.query("select count(*)::int n from staff_time_off where clinic_id=$1", [id]))
          .rows[0].n,
        1,
      );
      assert.equal(
        (
          await db.query("select count(*)::int n from clinic_onboarding_audit where clinic_id=$1", [
            id,
          ])
        ).rows[0].n,
        1,
      );
      await assert.rejects(
        attempt(db, () => provision(db, { ...payload(), owner_name: "Changed" })),
        /conflicts/,
      );
      await assert.rejects(
        attempt(db, () => provision(db, payload(uuid(920)), "duplicate-key-002")),
        /contact already exists/,
      );
    });
    const split = payload(uuid(920));
    split.clinic.phone = "+96555550124";
    split.clinic.opening_hours.days[0].periods = [
      { start: "09:00", end: "12:00" },
      { start: "13:00", end: "17:00" },
    ];
    await trusted(db, async () => {
      await assert.rejects(
        attempt(db, () => provision(db, split, "retry-after-failure")),
        /practitioner schedule must fit/,
      );
      assert.equal(
        (await db.query("select count(*)::int n from profiles where auth_user_id=$1", [uuid(920)]))
          .rows[0].n,
        0,
      );
      const fixed = payload(uuid(920));
      fixed.clinic.phone = split.clinic.phone;
      assert.ok((await provision(db, fixed, "retry-after-failure")).rows[0].id);
    });
  } finally {
    await db.close();
  }
});
test("rejects malformed/incomplete intake and untrusted provisioning without partial records", async () => {
  const db = await setup();
  try {
    for (const user of [tenants[0].user, tenants[1].user])
      await asUser(
        db,
        user,
        async () =>
          await assert.rejects(
            attempt(db, () => provision(db)),
            (e) => e.code === "42501",
          ),
      );
    await asRole(
      db,
      "anon",
      {},
      async () =>
        await assert.rejects(
          attempt(db, () => provision(db)),
          (e) => e.code === "42501",
        ),
    );
    const cases = [
      (p) => delete p.clinic.address,
      (p) => (p.services[0].duration_minutes = 0),
      (p) => p.services.push({ ...p.services[0] }),
      (p) => (p.practitioners[0].services = ["Unknown"]),
      (p) => (p.practitioners = []),
      (p) => delete p.practitioners[0].availability,
      (p) => p.practitioners[0].availability.push({ ...p.practitioners[0].availability[0] }),
      (p) => (p.clinic.timezone = "Bad/Zone"),
      (p) => (p.clinic.phone = "555123"),
      (p) => (p.clinic.opening_hours.days[0].periods = [{ start: "18:00", end: "09:00" }]),
      (p) => (p.closures = ["2026-02-30"]),
      (p) => (p.synthetic = "false"),
      (p) => (p.owner_auth_id = tenants[0].user),
      (p) => (p.practitioners[0].services = ["Consultation", "Consultation"]),
      (p) => (p.clinic.opening_hours = { days: [] }),
    ];
    await trusted(db, async () => {
      for (const change of cases) {
        const p = payload();
        change(p);
        await assert.rejects(attempt(db, () => provision(db, p)));
      }
      assert.equal((await db.query("select count(*)::int n from clinic_onboarding")).rows[0].n, 0);
    });
  } finally {
    await db.close();
  }
});
test("activation fails closed; explicit trusted approval; suspension and closure deny retained JWT", async () => {
  const db = await setup();
  try {
    let id;
    await trusted(db, async () => {
      id = (await provision(db)).rows[0].id;
      let r = (await readiness(db, id)).rows[0].r;
      assert.equal(r.state, "configuration_complete");
      assert.equal(r.external_dependencies.length, 4);
      await assert.rejects(
        attempt(db, () => decide(db, id, "activate")),
        /approval required/,
      );
    });
    await asUser(db, uuid(910), async () => {
      assert.equal((await readiness(db, id)).rows[0].r.configuration_complete, true);
      await assert.rejects(
        attempt(db, () => readiness(db, tenants[0].clinic)),
        (e) => e.code === "42501",
      );
      await assert.rejects(
        attempt(db, () => decide(db, id, "activate", true)),
        (e) => e.code === "42501",
      );
      await assert.rejects(
        attempt(db, () =>
          db.query("update clinic_onboarding set lifecycle='activated' where clinic_id=$1", [id]),
        ),
        (e) => e.code === "42501",
      );
    });
    await trusted(db, async () => {
      await decide(db, id, "review_technical");
      assert.equal((await readiness(db, id)).rows[0].r.state, "technically_activation_ready");
      await decide(db, id, "await_external");
      assert.equal((await readiness(db, id)).rows[0].r.state, "awaiting_external_dependencies");
      await decide(db, id, "activate", true);
      assert.equal((await readiness(db, id)).rows[0].r.state, "activated");
      await decide(db, id, "suspend");
    });
    await asUser(db, uuid(910), async () => {
      assert.equal((await db.query("select current_clinic_id() id")).rows[0].id, null);
      assert.equal((await db.query("select * from staff")).rows.length, 0);
      await assert.rejects(
        attempt(db, () => readiness(db, id)),
        (e) => e.code === "42501",
      );
    });
    await trusted(db, async () => {
      await decide(db, id, "reactivate");
      assert.notEqual((await readiness(db, id)).rows[0].r.state, "activated");
      await decide(db, id, "close");
      await assert.rejects(
        attempt(db, () => decide(db, id, "reactivate")),
        /closed/,
      );
    });
  } finally {
    await db.close();
  }
});
test("synthetic clinics and missing live practitioner mappings never report ready", async () => {
  const db = await setup();
  try {
    await trusted(db, async () => {
      const p = payload();
      p.synthetic = true;
      const id = (await provision(db, p)).rows[0].id;
      assert.equal((await readiness(db, id)).rows[0].r.configuration_complete, false);
      await assert.rejects(
        attempt(db, () => decide(db, id, "activate", true)),
        /Configuration/,
      );
      await db.query("update staff set active=false where clinic_id=$1", [id]);
      assert.match(
        JSON.stringify((await readiness(db, id)).rows[0].r.failures),
        /scheduled practitioner/,
      );
    });
  } finally {
    await db.close();
  }
});

test("interrupted staff provisioning rolls back clinic and owner, then recovers with same key", async () => {
  const db = await setup();
  try {
    await db.exec(
      "create function interrupt_intake() returns trigger language plpgsql as $$begin raise exception 'Synthetic interruption';end$$; create trigger synthetic_interrupt before insert on staff for each row execute function interrupt_intake()",
    );
    await trusted(
      db,
      async () =>
        await assert.rejects(
          attempt(db, () => provision(db)),
          /Synthetic interruption/,
        ),
    );
    assert.equal(
      (
        await db.query("select count(*)::int n from clinics where phone=$1", [
          payload().clinic.phone,
        ])
      ).rows[0].n,
      0,
    );
    assert.equal(
      (await db.query("select count(*)::int n from profiles where auth_user_id=$1", [uuid(910)]))
        .rows[0].n,
      0,
    );
    await db.exec("drop trigger synthetic_interrupt on staff;drop function interrupt_intake()");
    await trusted(db, async () => assert.ok((await provision(db)).rows[0].id));
  } finally {
    await db.close();
  }
});

test("readiness rejects live closure/schedule drift and stale technical approval; normal clinical operations preserve activation", async () => {
  const db = await setup();
  try {
    let id;
    await trusted(db, async () => {
      id = (await provision(db)).rows[0].id;
      await decide(db, id, "review_technical");
    });
    // Evaluate each damaging edit in a savepoint so the fixture remains reusable.
    for (const [sql, message] of [
      ["update staff set full_name='' where clinic_id=$1", /Complete active practitioner names/],
      ["update profiles set full_name='' where clinic_id=$1 and role='owner'", /owner name/],
      ["delete from staff_time_off where clinic_id=$1", /closure time off/],
      [
        "update staff_availability set day_of_week=5 where clinic_id=$1 and day_of_week=0",
        /outside clinic operating hours/,
      ],
      [
        "update staff_availability set end_time=start_time+interval '10 minutes' where clinic_id=$1",
        /scheduled practitioner/,
      ],
      [
        "update staff set services=array['Unknown'] where clinic_id=$1",
        /reviewed duration catalog/,
      ],
    ])
      await trusted(
        db,
        async () =>
          await attempt(db, async () => {
            await db.query(sql, [id]);
            const r = (await readiness(db, id)).rows[0].r;
            assert.equal(r.configuration_complete, false);
            assert.match(JSON.stringify(r.failures), message);
            await assert.rejects(attempt(db, () => decide(db, id, "activate", true)));
          }),
      );
    await trusted(db, async () => {
      await db.query("update clinics set receptionist_name='Updated receptionist' where id=$1", [
        id,
      ]);
      assert.equal((await readiness(db, id)).rows[0].r.state, "configuration_complete");
      await assert.rejects(
        attempt(db, () => decide(db, id, "activate", true)),
        /approval required/,
      );
      await decide(db, id, "review_technical");
      await decide(db, id, "activate", true);
      await db.query(
        "insert into clients(clinic_id,full_name,phone) values($1,'Synthetic operational client','+96555550199')",
        [id],
      );
      assert.equal((await readiness(db, id)).rows[0].r.state, "activated");
      assert.equal((await readiness(db, id)).rows[0].r.configuration_complete, true);
    });
  } finally {
    await db.close();
  }
});

test("banned and soft-deleted accounts cannot provision or retain tenant authorization", async () => {
  const db = await setup();
  try {
    await db.exec(
      "alter table auth.users add column banned_until timestamptz;alter table auth.users add column deleted_at timestamptz",
    );
    await db.query("update auth.users set banned_until=now()+interval '1 day' where id=$1", [
      uuid(910),
    ]);
    await trusted(
      db,
      async () =>
        await assert.rejects(
          attempt(db, () => provision(db)),
          /Verified existing owner/,
        ),
    );
    await db.query("update auth.users set banned_until=null where id=$1", [uuid(910)]);
    let id;
    await trusted(db, async () => {
      id = (await provision(db)).rows[0].id;
    });
    for (const patch of ["banned_until=now()+interval '1 day'", "deleted_at=now()"]) {
      await db.query(`update auth.users set ${patch} where id=$1`, [uuid(910)]);
      await asUser(db, uuid(910), async () => {
        assert.equal((await db.query("select current_clinic_id() id")).rows[0].id, null);
        assert.equal((await db.query("select * from clients")).rows.length, 0);
      });
      await trusted(db, async () =>
        assert.equal((await readiness(db, id)).rows[0].r.configuration_complete, false),
      );
      await db.query("update auth.users set banned_until=null,deleted_at=null where id=$1", [
        uuid(910),
      ]);
    }
  } finally {
    await db.close();
  }
});

test("clinical cleanup assessment never deletes records and is invalidated by new inventory before activation", async () => {
  const db = await setup();
  try {
    await trusted(db, async () => {
      const id = (await provision(db)).rows[0].id;
      const addClient = () =>
        db.query(
          "insert into clients(clinic_id,full_name,phone) values($1,'Synthetic assessment client','+96555550188')",
          [id],
        );
      await addClient();
      assert.equal((await readiness(db, id)).rows[0].r.configuration_complete, false);
      await decide(db, id, "review_data");
      assert.equal((await readiness(db, id)).rows[0].r.configuration_complete, true);
      assert.equal(
        (await db.query("select count(*)::int n from clients where clinic_id=$1", [id])).rows[0].n,
        1,
      );
      await db.query(
        "update clients set full_name='Changed assessment contents' where clinic_id=$1",
        [id],
      );
      assert.equal((await readiness(db, id)).rows[0].r.configuration_complete, false);
      await decide(db, id, "review_data");
      await decide(db, id, "review_technical");
      await addClient();
      assert.equal((await readiness(db, id)).rows[0].r.configuration_complete, false);
      await assert.rejects(
        attempt(db, () => decide(db, id, "activate", true)),
        /Configuration/,
      );
    });
  } finally {
    await db.close();
  }
});

test("legacy international-prefix and Kuwait-local clinic phones cannot duplicate E.164 intake", async () => {
  const db = await setup();
  try {
    for (const phone of ["00965 5555 0123", "55550123", "96555550123"]) {
      await db.query("update clinics set phone=$1,timezone='Asia/Kuwait' where id=$2", [
        phone,
        tenants[0].clinic,
      ]);
      await trusted(
        db,
        async () =>
          await assert.rejects(
            attempt(db, () => provision(db)),
            /contact already exists/,
          ),
      );
    }
  } finally {
    await db.close();
  }
});

test("public split hours require explicit practitioner shifts and never widen availability", async () => {
  const db = await setup();
  try {
    await trusted(db, async () => {
      const p = payload();
      p.clinic.opening_hours.days[0].periods = [
        { start: "09:00", end: "12:00" },
        { start: "13:00", end: "17:00" },
      ];
      p.practitioners[0].availability = [{ day: 0, start: "13:00", end: "17:00" }];
      const id = (await provision(db, p)).rows[0].id;
      assert.deepEqual(
        (
          await db.query(
            "select day_of_week,start_time,end_time from staff_availability where clinic_id=$1",
            [id],
          )
        ).rows,
        [{ day_of_week: 0, start_time: "13:00:00", end_time: "17:00:00" }],
      );
      assert.equal((await readiness(db, id)).rows[0].r.configuration_complete, true);
    });
  } finally {
    await db.close();
  }
});

test("disabled database enforcement blocks readiness and explicit activation", async () => {
  const db = await setup();
  try {
    let id;
    await trusted(db, async () => {
      id = (await provision(db)).rows[0].id;
      await decide(db, id, "review_technical");
    });
    await db.exec("alter table public.clients disable row level security");
    await trusted(db, async () => {
      const r = (await readiness(db, id)).rows[0].r;
      assert.equal(r.configuration_complete, false);
      assert.match(JSON.stringify(r.failures), /row security.*clients/);
      await assert.rejects(
        attempt(db, () => decide(db, id, "activate", true)),
        /Configuration/,
      );
    });
    await db.exec(
      "alter table public.clients enable row level security;grant execute on function public.provision_clinic(text,jsonb) to authenticated",
    );
    await trusted(db, async () => {
      assert.equal((await readiness(db, id)).rows[0].r.configuration_complete, false);
      assert.match(
        JSON.stringify((await readiness(db, id)).rows[0].r.failures),
        /Restrict administrative/,
      );
    });
  } finally {
    await db.close();
  }
});

test("existing-clinic registration is explicit, consistent, retry-safe and preserves membership/schedules", async () => {
  const db = await setup();
  try {
    let cid;
    await trusted(db, async () => {
      cid = (await provision(db)).rows[0].id;
    });
    await db.query("delete from clinic_onboarding where clinic_id=$1", [cid]);
    const baseline = (
      await db.query("select id,auth_user_id,clinic_id,role from profiles where clinic_id=$1", [
        cid,
      ])
    ).rows;
    const register = (p = payload()) =>
      db.query("select register_existing_clinic_intake($1,$2,$3,$4) id", [
        cid,
        "legacy-clinic-intake",
        JSON.stringify(p),
        "Synthetic legacy intake review",
      ]);
    await asUser(
      db,
      uuid(910),
      async () =>
        await assert.rejects(
          attempt(db, () => register()),
          (e) => e.code === "42501",
        ),
    );
    await trusted(db, async () => {
      const bad = payload();
      bad.clinic.name = "Conflicting saved name";
      await assert.rejects(
        attempt(db, () => register(bad)),
        /differs from intake/,
      );
      const badSchedule = payload();
      badSchedule.practitioners[0].availability[0].start = "10:00";
      await assert.rejects(
        attempt(db, () => register(badSchedule)),
        /practitioner or schedule differs/,
      );
      assert.equal((await register()).rows[0].id, cid);
      assert.equal((await register()).rows[0].id, cid);
    });
    assert.deepEqual(
      (
        await db.query("select id,auth_user_id,clinic_id,role from profiles where clinic_id=$1", [
          cid,
        ])
      ).rows,
      baseline,
    );
    assert.equal(
      (
        await db.query(
          "select count(*)::int n from clinic_onboarding_audit where clinic_id=$1 and event=$2",
          [cid, "intake_registered"],
        )
      ).rows[0].n,
      1,
    );
    await db.exec("create table public.clinic_offboarding(clinic_id uuid primary key,state text)");
    await db.query("insert into clinic_offboarding values($1,'grace')", [cid]);
    await asUser(db, uuid(910), async () =>
      assert.equal((await db.query("select current_clinic_id() id")).rows[0].id, null),
    );
    await trusted(
      db,
      async () =>
        await assert.rejects(
          attempt(db, () => register()),
          /offboarding/,
        ),
    );
  } finally {
    await db.close();
  }
});
