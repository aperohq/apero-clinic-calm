import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  attempt,
  asRole,
  asUser,
  createClinicDatabase,
  internalTables,
  loadSql,
  portalTables,
  productTables,
  tenants,
  uuid,
} from "./helpers/clinic-database.mjs";

let db;
after(async () => {
  await db?.close();
});
const [a, b] = tenants;
const ownedColumn = (table) => (table === "clinics" ? "id" : "clinic_id");
const denied = (sql, values = [], allowedCodes = ["42501"]) =>
  assert.rejects(
    attempt(db, () => db.query(sql, values)),
    (error) => allowedCodes.includes(error.code),
    `Database must reject: ${sql}`,
  );
const insertFor = (table, t) => {
  const id = uuid(900);
  const values = {
    clinics: { id: t.clinic, name: "Forged clinic" },
    profiles: {
      id,
      auth_user_id: uuid(999),
      clinic_id: t.clinic,
      full_name: "Forged user",
      email: "fake@example.test",
    },
    clients: { id, clinic_id: t.clinic, full_name: "New patient", phone: "+12025550102" },
    staff: { id, clinic_id: t.clinic, full_name: "New staff", specialty: "General" },
    staff_availability: { id, clinic_id: t.clinic, staff_id: t.staff, day_of_week: 2 },
    staff_time_off: {
      id,
      clinic_id: t.clinic,
      staff_id: t.staff,
      start_time: "2030-01-01T09:00Z",
      end_time: "2030-01-01T10:00Z",
    },
    appointments: {
      id,
      clinic_id: t.clinic,
      client_id: t.client,
      staff_id: t.staff,
      service: "Consultation",
      start_time: "2030-01-01T09:00Z",
      end_time: "2030-01-01T10:00Z",
    },
    conversations: { id, clinic_id: t.clinic, title: "Forged call" },
    client_notes: {
      id,
      clinic_id: t.clinic,
      client_id: t.client,
      author_profile_id: t.profile,
      note: "New note",
    },
    notifications: { id, clinic_id: t.clinic, profile_id: t.profile, title: "New notification" },
    voice_requests: {
      id,
      clinic_id: t.clinic,
      request_key: `new-request-${id}`,
      kind: "callback",
      phone: "+12025550102",
      reason: "Forged request",
    },
    voice_operations: {
      operation_key: "new-operation-key",
      clinic_id: t.clinic,
      action: "book",
      result: {},
    },
    voice_call_state: { call_id: "new-call", clinic_id: t.clinic },
    voice_checked_slots: {
      id,
      check_id: t.check,
      call_id: t.call,
      clinic_id: t.clinic,
      staff_id: t.staff,
      service: "Consultation",
      start_time: "2030-01-01T09:00Z",
      end_time: "2030-01-01T10:00Z",
      expires_at: "2030-01-01T09:00Z",
    },
    voice_integrations: {
      clinic_id: t.clinic,
      workspace_id: "new-workspace",
      agent_id: "new-agent",
      secret_env_name: "RETELL_TEST_NEW",
    },
    clinic_service_aliases: { clinic_id: t.clinic, service: "Consultation", alias: "new-alias" },
  }[table];
  const columns = Object.keys(values);
  return [
    `insert into public.${table} (${columns.join(",")}) values (${columns.map((_, i) => `$${i + 1}`).join(",")}) returning *`,
    Object.values(values),
  ];
};
const updates = {
  clinics: "name = 'Updated clinic'",
  profiles: "full_name = 'Updated name'",
  clients: "full_name = 'Updated patient'",
  staff: "full_name = 'Updated staff'",
  staff_availability: "is_available = false",
  staff_time_off: "reason = 'Updated leave'",
  appointments: "service = 'Updated service'",
  conversations: "title = 'Forged call'",
  client_notes: "note = 'Forged note'",
  notifications: "read = true",
  voice_requests: "status = 'Closed'",
};
const canInsert = [
  "clients",
  "staff",
  "staff_availability",
  "staff_time_off",
  "appointments",
  "client_notes",
  "notifications",
];
const canUpdate = portalTables.filter(
  (table) => !["conversations", "client_notes"].includes(table),
);
const canDelete = canInsert;

test("clinic isolation enforced by PostgreSQL grants, RLS, triggers, and foreign keys", async (t) => {
  db = await createClinicDatabase();
  await t.test(
    "legacy broad grants permit cross-clinic TRUNCATE despite otherwise correct RLS",
    async () => {
      await asUser(db, a.user, async () => {
        assert.equal(
          (await db.query("select count(*)::int as n from public.client_notes")).rows[0].n,
          1,
        );
        await db.exec("truncate public.client_notes");
        await db.exec("reset role");
        assert.equal(
          (
            await db.query(
              "select count(*)::int as n from public.client_notes where clinic_id = $1",
              [b.clinic],
            )
          ).rows[0].n,
          0,
        );
      });
      assert.equal(
        (
          await db.query(
            "select count(*)::int as n from public.client_notes where clinic_id = $1",
            [b.clinic],
          )
        ).rows[0].n,
        1,
        "attack rolled back",
      );
    },
  );
  // Include inherited PUBLIC and stale column grants in the remediation test.
  await db.exec(
    "grant select on public.voice_integrations to public; grant update (clinic_id) on public.voice_requests to authenticated",
  );
  await loadSql(db, "../tests/fixtures/10_clinic_access_privileges.sql");
  await loadSql(db, "../tests/fixtures/10_clinic_access_privileges.sql"); // repeat-safe migration
  await t.test("complete table inventory has RLS and browser roles cannot bypass it", async () => {
    const { rows } = await db.query(
      "select relname, relrowsecurity from pg_class join pg_namespace on pg_namespace.oid = relnamespace where nspname = 'public' and relkind in ('r','p') order by relname",
    );
    assert.deepEqual(
      rows.map((r) => r.relname),
      [
        ...productTables,
        ...(process.env.APERO_TEST_TEAM_MIGRATION === "1"
          ? ["clinic_invitation_claims", "clinic_invitation_budgets"]
          : []),
      ].sort(),
    );
    assert.ok(rows.every((r) => r.relrowsecurity));
    const roles = await db.query(
      "select rolname, rolsuper, rolbypassrls from pg_roles where rolname in ('authenticated','anon')",
    );
    assert.ok(roles.rows.every((r) => !r.rolsuper && !r.rolbypassrls));
  });
  for (const [own, other] of [
    [a, b],
    [b, a],
  ]) {
    for (const table of portalTables) {
      await t.test(
        `${own.user}: ${table} SELECT without frontend filters returns only own clinic`,
        async () => {
          await asUser(
            db,
            own.user,
            async () => {
              const rows = (await db.query(`select * from public.${table}`)).rows;
              assert.ok(rows.length > 0);
              assert.ok(rows.every((row) => row[ownedColumn(table)] === own.clinic));
              assert.deepEqual(
                (
                  await db.query(`select * from public.${table} where ${ownedColumn(table)} = $1`, [
                    other.clinic,
                  ])
                ).rows,
                [],
              );
            },
            { clinic_id: other.clinic, user_metadata: { clinic_id: other.clinic } },
          );
        },
      );
      await t.test(
        `${own.user}: ${table} INSERT permits only supported own-clinic operations`,
        async () => {
          await asUser(db, own.user, async () => {
            await denied(...insertFor(table, other));
            if (canInsert.includes(table)) {
              const result = await attempt(db, () => db.query(...insertFor(table, own)));
              assert.equal(result.rows.length, 1);
              assert.equal(result.rows[0].clinic_id, own.clinic);
            } else await denied(...insertFor(table, own));
          });
        },
      );
      await t.test(`${own.user}: ${table} UPDATE cannot touch other-clinic rows`, async () => {
        await asUser(db, own.user, async () => {
          const statement = `update public.${table} set ${updates[table]} where ${ownedColumn(table)} = $1 returning *`;
          if (canUpdate.includes(table)) {
            assert.deepEqual(
              (await attempt(db, () => db.query(statement, [other.clinic]))).rows,
              [],
            );
            assert.ok((await attempt(db, () => db.query(statement, [own.clinic]))).rows.length > 0);
          } else {
            await denied(statement, [other.clinic]);
            await denied(statement, [own.clinic]);
          }
        });
      });
      await t.test(`${own.user}: ${table} DELETE cannot touch other-clinic rows`, async () => {
        await asUser(db, own.user, async () => {
          const statement = `delete from public.${table} where ${ownedColumn(table)} = $1 returning *`;
          if (canDelete.includes(table)) {
            assert.deepEqual(
              (await attempt(db, () => db.query(statement, [other.clinic]))).rows,
              [],
            );
            await attempt(db, async () => {
              // Delete a fresh own-clinic row without historical dependencies;
              // booked staff may legitimately be retained by foreign keys.
              await db.query(...insertFor(table, own));
              const result = await db.query(
                `delete from public.${table} where id = $1 returning *`,
                [uuid(900)],
              );
              assert.equal(result.rows.length, 1);
              assert.equal(result.rows[0].clinic_id, own.clinic);
            });
          } else {
            await denied(statement, [other.clinic]);
            await denied(statement, [own.clinic]);
          }
        });
      });
      await t.test(
        `${own.user}: ${table} rejects moving own rows into another clinic`,
        async () => {
          await asUser(db, own.user, async () => {
            await denied(
              `update public.${table} set ${ownedColumn(table)} = $1 where ${ownedColumn(table)} = $2`,
              [other.clinic, own.clinic],
              ["42501", "P0001", "23503"],
            );
          });
        },
      );
    }
    for (const table of internalTables) {
      await t.test(`${own.user}: server-only ${table} rejects all browser operations`, async () => {
        await asUser(db, own.user, async () => {
          await denied(`select * from public.${table}`);
          await denied(...insertFor(table, own));
          await denied(...insertFor(table, other));
          await denied(`update public.${table} set clinic_id = $1`, [own.clinic]);
          await denied(`delete from public.${table}`);
        });
      });
    }
  }
  await t.test(
    "browser roles have no table-wide TRUNCATE, REFERENCES, or TRIGGER grants",
    async () => {
      for (const role of ["authenticated", "anon"])
        for (const table of productTables) {
          for (const privilege of ["TRUNCATE", "REFERENCES", "TRIGGER"]) {
            const result = await db.query("select has_table_privilege($1, $2, $3) as allowed", [
              role,
              `public.${table}`,
              privilege,
            ]);
            assert.equal(result.rows[0].allowed, false, `${role} ${table} ${privilege}`);
          }
          await asRole(db, role, role === "anon" ? {} : { sub: a.user, role }, async () => {
            await denied(`truncate public.${table} cascade`);
          });
        }
    },
  );
  await t.test("anonymous visitors cannot read or write any product table", async () => {
    await asRole(db, "anon", {}, async () => {
      for (const table of productTables) {
        await denied(`select * from public.${table}`);
        await denied(...insertFor(table, a));
        await denied(`update public.${table} set ${ownedColumn(table)} = $1`, [a.clinic]);
        await denied(`delete from public.${table}`);
      }
    });
  });
  await t.test(
    "an authenticated user without a clinic has no product rows or write access",
    async () => {
      const user = uuid(777);
      await db.query("insert into auth.users(id, email) values ($1, 'unlinked@example.test')", [
        user,
      ]);
      await asUser(db, user, async () => {
        assert.equal(
          (await db.query("select public.current_clinic_id() as clinic")).rows[0].clinic,
          null,
        );
        for (const table of portalTables) {
          assert.deepEqual((await db.query(`select * from public.${table}`)).rows, []);
          await denied(...insertFor(table, a));
        }
      });
    },
  );
  await t.test(
    "profile identity and column-limited notification/request fields cannot be forged",
    async () => {
      await asUser(db, a.user, async () => {
        for (const column of ["id", "auth_user_id", "clinic_id", "email", "role"]) {
          await denied(`update public.profiles set ${column} = ${column} where id = $1`, [
            a.profile,
          ]);
        }
        await denied("update public.voice_requests set reason = 'forged' where id = $1", [
          a.request,
        ]);
        await denied("update public.voice_requests set clinic_id = $1 where id = $2", [
          b.clinic,
          a.request,
        ]);
        await denied("update public.notifications set title = 'forged' where id = $1", [
          a.notification,
        ]);
      });
    },
  );
  await t.test(
    "own-clinic rows cannot reference another clinic's patients, staff, or profiles",
    async () => {
      await asUser(db, a.user, async () => {
        for (const [table, column, foreignId] of [
          ["appointments", "client_id", b.client],
          ["appointments", "staff_id", b.staff],
          ["staff_availability", "staff_id", b.staff],
          ["staff_time_off", "staff_id", b.staff],
        ])
          await denied(
            `update public.${table} set ${column} = $1 where clinic_id = $2`,
            [foreignId, a.clinic],
            ["P0001", "23503"],
          );
        await denied(
          "insert into public.client_notes(clinic_id, client_id, author_profile_id, note) values ($1,$2,$3,'forged')",
          [a.clinic, b.client, a.profile],
          ["P0001", "23503"],
        );
        await denied(
          "insert into public.notifications(clinic_id, profile_id, title) values ($1,$2,'forged')",
          [a.clinic, b.profile],
          ["P0001", "23503"],
        );
      });
    },
  );
  await t.test(
    "staff RPC derives the clinic from membership and service-only RPC cannot be invoked",
    async () => {
      await asUser(db, a.user, async () => {
        await attempt(db, async () => {
          const result = await db.query(
            "select public.create_staff_with_schedule('New practitioner','General','','',array['Consultation'],'[]'::jsonb) as id",
          );
          const staff = await db.query("select clinic_id from public.staff where id = $1", [
            result.rows[0].id,
          ]);
          assert.equal(staff.rows[0].clinic_id, a.clinic);
        });
        await denied(
          "select public.voice_apply_appointment('cancel',$1,'malicious-operation-key',null,$2,null,null,null,null,null,null,null,null,null,null)",
          [b.clinic, b.appointment],
        );
      });
    },
  );
  await t.test(
    "service-role reads and existing voice routing remain explicitly separate from browser roles",
    async () => {
      await asRole(db, "service_role", { role: "service_role" }, async () => {
        for (const table of [
          "clinics",
          "profiles",
          "clients",
          "conversations",
          "voice_integrations",
          "voice_call_state",
          "voice_requests",
        ]) {
          const rows = (await db.query(`select * from public.${table}`)).rows;
          assert.ok(rows.some((r) => r[ownedColumn(table)] === a.clinic));
          assert.ok(rows.some((r) => r[ownedColumn(table)] === b.clinic));
        }
      });
    },
  );
  await t.test(
    "existing appointment-RPC tenant isolation fixture passes in local PostgreSQL",
    async () => {
      const sql = await readFile(
        new URL("./fixtures/tenant_isolation.sql", import.meta.url),
        "utf8",
      );
      await db.exec(sql);
    },
  );
  await t.test(
    "clinic authorization follows membership when another user belongs to the same clinic",
    async () => {
      const user = uuid(778);
      await db.query("insert into auth.users(id,email) values ($1,'second-member@example.test')", [
        user,
      ]);
      await db.query(
        "insert into public.profiles(auth_user_id,clinic_id,full_name,email,role) values ($1,$2,'Second member','second-member@example.test','owner')",
        [user, a.clinic],
      );
      await asUser(db, user, async () => {
        assert.equal(
          (await db.query("select public.current_clinic_id() as clinic")).rows[0].clinic,
          a.clinic,
        );
        assert.ok(
          (await db.query("select * from public.clients")).rows.every(
            (row) => row.clinic_id === a.clinic,
          ),
        );
        assert.deepEqual(
          (
            await db.query(
              "update public.profiles set full_name = 'forged' where id = $1 returning id",
              [a.profile],
            )
          ).rows,
          [],
        );
        assert.deepEqual(
          (await db.query("select * from public.clients where clinic_id = $1", [b.clinic])).rows,
          [],
        );
      });
    },
  );
  await t.test(
    "read-only deployment inspection SQL executes without changing policies",
    async () => {
      const before = await db.query(
        "select tablename,policyname,qual,with_check from pg_policies where schemaname='public' order by tablename,policyname",
      );
      const sql = await readFile(
        new URL("./fixtures/clinic_isolation_inspect.sql", import.meta.url),
        "utf8",
      );
      const results = await db.exec(sql);
      assert.equal(results.length, 1, "SQL Editor receives exactly one result set");
      const report = results[0].rows;
      const tables = report.filter((row) => row.section === "TABLE");
      assert.deepEqual(tables.map((row) => row.table_name).sort(), [...productTables].sort());
      assert.ok(tables.every((row) => row.object_exists && row.rls_enabled));
      assert.ok(tables.every((row) => row.anon_grants === ""));
      assert.equal(
        tables.find((row) => row.table_name === "profiles").authenticated_grants,
        "SELECT\nUPDATE (full_name), UPDATE (phone)",
      );
      const policies = report.filter((row) => row.section === "POLICY");
      assert.equal(policies.length, before.rows.length);
      for (const policy of before.rows) {
        const row = policies.find(
          (row) => row.table_name === policy.tablename && row.policy_name === policy.policyname,
        );
        assert.ok(row.policy_command);
        assert.equal(row.policy_using, policy.qual);
        assert.equal(row.policy_with_check, policy.with_check);
      }
      for (const section of ["FUNCTION", "TRIGGER", "CONSTRAINT", "REQUIRED COLUMN"]) {
        assert.ok(report.some((row) => row.section === section));
        assert.ok(
          report.filter((row) => row.section === section).every((row) => row.object_exists),
        );
      }
      assert.equal(
        report.find(
          (row) => row.section === "FUNCTION" && row.object_name === "public.current_clinic_id()",
        ).authenticated_grants,
        "true",
      );
      assert.equal(
        report.find(
          (row) => row.section === "FUNCTION" && row.object_name === "public.current_clinic_id()",
        ).anon_grants,
        "false",
      );
      await db.exec("begin");
      try {
        await attempt(db, async () => {
          await db.exec(`alter table public.clinics rename column logo_url to inspection_test_logo;
          alter table public.clients rename to inspection_test_clients;
          alter function public.current_profile_id() rename to inspection_test_profile_id;
          alter table public.notifications disable trigger guard_notifications_read_only`);
          const changed = (await db.exec(sql))[0].rows;
          assert.equal(
            changed.find((row) => row.section === "TABLE" && row.table_name === "clients")
              .object_exists,
            false,
          );
          assert.equal(
            changed.find(
              (row) => row.section === "REQUIRED COLUMN" && row.object_name === "logo_url",
            ).object_exists,
            false,
          );
          assert.equal(
            changed.find(
              (row) =>
                row.section === "FUNCTION" && row.object_name === "public.current_profile_id()",
            ).object_exists,
            false,
          );
          assert.equal(
            changed.find(
              (row) =>
                row.section === "TRIGGER" && row.object_name === "guard_notifications_read_only",
            ).details.enabled,
            "D",
          );
        });
      } finally {
        await db.exec("rollback");
      }
      const after = await db.query(
        "select tablename,policyname,qual,with_check from pg_policies where schemaname='public' order by tablename,policyname",
      );
      assert.deepEqual(after.rows, before.rows);
    },
  );
});
