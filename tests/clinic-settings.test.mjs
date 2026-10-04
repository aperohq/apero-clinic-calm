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
import {
  validTimeZone,
  validateHours,
  normalizeSettings,
  settingsDraft,
  changedSettings,
  emptyHours,
} from "../src/lib/clinic-settings.ts";
import { toClinicInput } from "../src/lib/clinic-time.ts";
const [a, b] = tenants;
const migration = "../supabase/migrations/20261003200000_clinic_settings.sql";
const manager = { user: uuid(501), profile: uuid(502) },
  staff = { user: uuid(601), profile: uuid(602) };
const hours = emptyHours();
hours.days[1].periods = [
  { start: "09:00", end: "12:00" },
  { start: "13:00", end: "17:00" },
];

const settingsSql = "select * from update_clinic_settings($1::jsonb,$2::jsonb)";
function update(db, patch, expected) {
  return db.query(settingsSql, [JSON.stringify(patch), JSON.stringify(expected)]);
}
const denied = (db, fn) =>
  assert.rejects(attempt(db, fn), (error) => ["42501", "P0001"].includes(error.code));
const malformed = (db, fn) =>
  assert.rejects(
    attempt(db, fn),
    (error) => error.code === "22023" && error.message === "Invalid clinic settings",
  );

test("Canonical clinic Settings, real RLS, direct writes, revocation and timezone regressions", async (t) => {
  const db = await createClinicDatabase({ team: true, appointments: true, settings: false });
  try {
    const snapshot = async () =>
      (
        await db.query(
          "select id,name,phone,email,timezone,logo_url,created_at from clinics order by id",
        )
      ).rows;
    const policies = async () =>
      (
        await db.query(
          "select tablename,policyname,qual,with_check from pg_policies order by tablename,policyname",
        )
      ).rows;
    const history = async () =>
      Object.fromEntries(
        await Promise.all(
          [
            "profiles",
            "staff",
            "staff_availability",
            "staff_time_off",
            "appointments",
            "conversations",
            "voice_integrations",
          ].map(async (table) => [
            table,
            (await db.query(`select * from ${table} order by 1`)).rows,
          ]),
        ),
      );
    await db.query("update clinics set phone='legacy extension' where id=$1", [b.clinic]);
    const before = await snapshot(),
      policiesBefore = await policies(),
      historyBefore = await history();
    await loadSql(db, migration);
    await t.test(
      "non-destructive install/reinstall keeps clinic values, memberships/history and RLS",
      async () => {
        await loadSql(db, migration);
        assert.deepEqual(await snapshot(), before);
        assert.deepEqual(await policies(), policiesBefore);
        assert.deepEqual(await history(), historyBefore);
        assert.ok(
          (
            await db.query("select opening_hours,localized_name,receptionist_name from clinics")
          ).rows.every((row) => Object.values(row).every((value) => value === null)),
        );
        const funcs = (
          await db.query(
            "select proname,prosecdef,proconfig from pg_proc where proname in ('update_clinic_settings','validate_clinic_settings')",
          )
        ).rows;
        assert.ok(
          funcs.every(
            (row) =>
              !row.prosecdef && row.proconfig.includes("search_path=pg_catalog, public, pg_temp"),
          ),
        );
      },
    );
    await t.test(
      "legacy formatting survives install and does not block unrelated Owner edits",
      () =>
        asUser(db, b.user, async () => {
          const old = (await db.query("select * from clinics where id=$1", [b.clinic])).rows[0];
          const saved = (await update(db, { name: "Legacy clinic renamed" }, { name: old.name }))
            .rows[0];
          assert.equal(saved.phone, "legacy extension");
        }),
    );
    for (const [member, role] of [
      [manager, "manager"],
      [staff, "staff"],
    ]) {
      await db.query("insert into auth.users(id,email) values($1,$2)", [
        member.user,
        role + "@example.test",
      ]);
      await db.query(
        "insert into profiles(id,auth_user_id,clinic_id,full_name,email,role) values($1,$2,$3,$4,$5,$6)",
        [member.profile, member.user, a.clinic, role, role + "@example.test", role],
      );
    }
    async function serviceCommit(fn) {
      await db.exec("begin; set local role service_role");
      await db.query("select set_config('request.jwt.claims',$1,true)", [
        JSON.stringify({ role: "service_role" }),
      ]);
      try {
        await fn();
        await db.exec("commit");
      } catch (error) {
        await db.exec("rollback");
        throw error;
      }
    }
    await t.test(
      "operator onboarding writes and Settings read the same canonical clinic record",
      async () => {
        await serviceCommit(async () => {
          await db.query(
            "update clinics set localized_name='العيادة',clinic_type='Dental',address='Building 1',city='City',country='Country',receptionist_name='Apero',opening_hours=$1 where id=$2",
            [JSON.stringify(hours), a.clinic],
          );
          await asUserInnerOwnerRead();
        });
        async function asUserInnerOwnerRead() {
          assert.equal(
            (await db.query("select localized_name from clinics where id=$1", [a.clinic])).rows[0]
              .localized_name,
            "العيادة",
          );
        }
        await asUser(db, a.user, async () => {
          const row = (await db.query("select * from clinics where id=$1", [a.clinic])).rows[0];
          assert.equal(row.address, "Building 1");
          assert.deepEqual(row.opening_hours, hours);
        });
      },
    );
    await t.test(
      "Owner edits all clinic/contact/location/safe receptionist fields and clears optional values",
      () =>
        asUser(db, a.user, async () => {
          const patch = {
            name: "Patient-facing clinic",
            localized_name: "العيادة",
            clinic_type: "Dental",
            email: "clinic@example.test",
            website: "https://clinic.example.test/location",
            phone: "+1 (202) 555-0100",
            fallback_phone: "+1 202 555 0199",
            address: "Building 2",
            city: "Area / City",
            country: "Country",
            directions: "Turn left at the entrance",
            parking_information: "Visitor spaces",
            receptionist_name: "Receptionist",
            receptionist_localized_name: "المساعدة",
            opening_hours: hours,
          };
          const old = (await db.query("select * from clinics where id=$1", [a.clinic])).rows[0];
          const row = (
            await update(
              db,
              patch,
              Object.fromEntries(Object.keys(patch).map((key) => [key, old[key]])),
            )
          ).rows[0];
          for (const [key, val] of Object.entries(patch)) assert.deepEqual(row[key], val);
          const clearing = Object.fromEntries(
            Object.keys(patch)
              .filter((key) => key !== "name")
              .map((key) => [key, null]),
          );
          const cleared = (
            await update(
              db,
              clearing,
              Object.fromEntries(Object.keys(clearing).map((key) => [key, row[key]])),
            )
          ).rows[0];
          assert.ok(Object.keys(clearing).every((key) => cleared[key] === null));
          assert.equal(cleared.name, patch.name);
        }),
    );
    await t.test("partial save preserves unrelated clinic fields and all operational data", () =>
      asUser(db, a.user, async () => {
        const before = (await db.query("select * from clinics where id=$1", [a.clinic])).rows[0];
        const row = (await update(db, { name: "Changed" }, { name: before.name })).rows[0];
        const expected = { ...before, name: "Changed" };
        assert.deepEqual(row, expected);
      }),
    );
    await t.test(
      "stale same-field save fails atomically; unrelated concurrent field change is preserved",
      () =>
        asUser(db, a.user, async () => {
          const original = (await db.query("select * from clinics where id=$1", [a.clinic]))
            .rows[0];
          await update(db, { name: "New name" }, { name: original.name });
          await assert.rejects(
            attempt(db, () =>
              update(
                db,
                { name: "Stale name", email: "a@example.test" },
                { name: original.name, email: original.email },
              ),
            ),
            (error) => error.code === "40001",
          );
          const saved = (await update(db, { phone: "+12025550111" }, { phone: original.phone }))
            .rows[0];
          assert.equal(saved.name, "New name");
        }),
    );
    for (const [role, member] of [
      ["manager", manager],
      ["staff", staff],
    ])
      await t.test(
        `${role}: own clinic operational SELECT preserved; direct Settings update/RPC denied`,
        () =>
          asUser(db, member.user, async () => {
            assert.equal(
              (await db.query("select * from clinics where id=$1", [a.clinic])).rows.length,
              1,
            );
            await denied(db, () => update(db, { name: "Attack" }, { name: "not relevant" }));
            assert.equal(
              (
                await db.query(
                  "update clinics set name='Attack',directions='Attack' where id=$1 returning id",
                  [a.clinic],
                )
              ).rows.length,
              0,
            );
          }),
      );
    await t.test(
      "Clinic A cannot read/update B; forged patch cannot change identity or carry internal config",
      () =>
        asUser(db, a.user, async () => {
          assert.equal(
            (await db.query("select * from clinics where id=$1", [b.clinic])).rows.length,
            0,
          );
          assert.equal(
            (
              await db.query("update clinics set name='Attack' where id=$1 returning id", [
                b.clinic,
              ])
            ).rows.length,
            0,
          );
          for (const key of [
            "id",
            "clinic_id",
            "created_at",
            "secret_env_name",
            "retell_api_key",
            "prompt",
          ])
            await malformed(db, () => update(db, { [key]: b.clinic }, { [key]: null }));
          await denied(db, () =>
            db.query("update clinics set id=$1 where id=$2", [uuid(999), a.clinic]),
          );
        }),
    );
    for (const website of [
      "https://example.com",
      "https://www.example.com/path",
      "https://example.com/path?query=value#section",
      "http://localhost:3000",
      "https://127.0.0.1:443/",
      "https://[::1]/",
      "https://[2001:db8::1]:8443/path",
      "https://[2001:db8:0:0:0:0:0:1]/",
      "https://[::]/",
      "https://[::ffff:c000:201]/",
      null,
    ])
      await t.test(`valid website ${website} accepted by frontend, RPC and direct update`, () =>
        asUser(db, a.user, async () => {
          const old = (await db.query("select * from clinics where id=$1", [a.clinic])).rows[0];
          const normalized = normalizeSettings(
            { ...settingsDraft(old), website: website ?? "" },
            old,
          );
          assert.equal(normalized.website, website);
          const saved = (await update(db, { website }, { website: old.website })).rows[0];
          assert.deepEqual(saved, { ...old, website });
          // Force a real value change so the direct-write trigger cannot skip validation.
          await db.query("update clinics set website=$1 where id=$2", [
            website === null ? "https://different.example.com" : null,
            a.clinic,
          ]);
          const direct = (
            await db.query("update clinics set website=$1 where id=$2 returning *", [
              website,
              a.clinic,
            ])
          ).rows[0];
          assert.deepEqual(direct, { ...old, website });
        }),
      );
    const invalidWebsites = [
      "https://[::::]/",
      "https://[1:2:3]/",
      "https://[2001:db8::1::2]/",
      "https://[12345::1]/",
      "https://[gggg::1]/",
      "https://[127.0.0.1]/",
      "https://[::ffff:999.1.1.1]/",
      "https://[::ffff:192.0.2.1]/",
      "https://[::1/",
      "https://::1]/",
      "https://[]/",
      "https://[::1]extra/",
      "https://[::1]:invalid/",
      "https://[::1]:65536/",
      "https://",
      "https:///path",
      "https://:443/path",
      "https:/example.com",
      "https://example.com/a b",
      "",
    ];
    const invalidValues = [
      ...invalidWebsites.map((website) => ({ website })),
      { name: "" },
      { name: " " },
      { timezone: "Not/AZone" },
      { timezone: "EST" },
      { timezone: null },
      { email: "no-address" },
      { phone: "abcd" },
      { fallback_phone: "+1" },
      { website: "javascript:alert(1)" },
      { website: "https://user:password@clinic.test" },
      { website: "https://clinic.test:bad" },
      { website: "https://clinic.test:99999" },
      { directions: "x".repeat(4001) },
      { opening_hours: [] },
      { opening_hours: { days: [] } },
      { opening_hours: { days: Array(7).fill({ day: 1, periods: [] }) } },
      {
        opening_hours: {
          days: hours.days.map((d) =>
            d.day === 1 ? { day: 1, periods: [{ start: "11:00", end: "10:00" }] } : d,
          ),
        },
      },
      {
        opening_hours: {
          days: hours.days.map((d) =>
            d.day === 1
              ? {
                  day: 1,
                  periods: [
                    { start: "09:00", end: "12:00" },
                    { start: "11:00", end: "13:00" },
                  ],
                }
              : d,
          ),
        },
      },
      {
        opening_hours: {
          days: hours.days.map((d) =>
            d.day === 1 ? { day: 1, periods: [{ start: "25:00", end: "26:00" }] } : d,
          ),
        },
      },
    ];
    for (let i = 0; i < invalidValues.length; i++)
      await t.test(`malformed value ${i + 1} rejected by RPC and direct database update`, () =>
        asUser(db, a.user, async () => {
          const patch = invalidValues[i],
            field = Object.keys(patch)[0];
          const old = (await db.query("select * from clinics where id=$1", [a.clinic])).rows[0];
          if (["https://[::::]/", "https://[1:2:3]/"].includes(patch.website))
            assert.throws(() =>
              normalizeSettings({ ...settingsDraft(old), website: patch.website }, old),
            );
          await malformed(db, () => update(db, patch, { [field]: old[field] }));
          await malformed(db, () =>
            db.query(`update clinics set ${field}=$1 where id=$2`, [
              field === "opening_hours" ? JSON.stringify(patch[field]) : patch[field],
              a.clinic,
            ]),
          );
        }),
      );
    await t.test(
      "RPC rejects malformed patch/expected types, oversized work and unknown fields",
      () =>
        asUser(db, a.user, async () => {
          const oldName = (await db.query("select name from clinics where id=$1", [a.clinic]))
            .rows[0].name;
          for (const [patch, expected] of [
            [null, {}],
            [[], {}],
            [{}, {}],
            [{ name: [] }, { name: oldName }],
            [{ name: "x" }, {}],
            [{ name: "x".repeat(66000) }, { name: "x" }],
          ])
            await malformed(db, () => update(db, patch, expected));
        }),
    );
    await t.test(
      "UTC instants/history do not change; future display and availability use canonical IANA timezone",
      () =>
        asUser(db, a.user, async () => {
          const appointment = (
            await db.query("select * from appointments where id=$1", [a.appointment])
          ).rows[0];
          const schedules = (
            await db.query("select * from staff_availability where staff_id=$1", [a.staff])
          ).rows;
          const date = "2040-01-02"; // Monday, weekly practitioner 09:00–17:00.
          const getSlot = async () =>
            (
              await db.query(
                "select * from appointment_available_slots($1,$2,'Consultation',$3,null) order by start_time",
                [a.clinic, a.staff, date],
              )
            ).rows[0];
          const old = (
            await db.query("select timezone,opening_hours from clinics where id=$1", [a.clinic])
          ).rows[0];
          const beforeSlot = await getSlot();
          await update(
            db,
            { timezone: "Asia/Tokyo", opening_hours: emptyHours() },
            { timezone: old.timezone, opening_hours: old.opening_hours },
          );
          const afterSlot = await getSlot();
          assert.notEqual(beforeSlot.start_time.getTime(), afterSlot.start_time.getTime());
          assert.equal(
            toClinicInput(afterSlot.start_time.toISOString(), "Asia/Tokyo").slice(11),
            "09:00",
          );
          assert.deepEqual(
            (await db.query("select * from appointments where id=$1", [a.appointment])).rows[0],
            appointment,
          );
          assert.deepEqual(
            (await db.query("select * from staff_availability where staff_id=$1", [a.staff])).rows,
            schedules,
          );
          assert.ok(afterSlot); // Public all-closed hours do not become booking restrictions.
        }),
    );
    await t.test(
      "retained revoked Owner session loses settings reads, RPC and direct writes",
      async () => {
        await serviceCommit(() =>
          db.query("update profiles set revoked_at=now() where id=$1", [a.profile]),
        );
        await asUser(db, a.user, async () => {
          assert.equal((await db.query("select * from clinics")).rows.length, 0);
          await denied(db, () => update(db, { name: "Attack" }, { name: "x" }));
          assert.equal(
            (
              await db.query("update clinics set name='Attack' where id=$1 returning id", [
                a.clinic,
              ])
            ).rows.length,
            0,
          );
        });
      },
    );
    await t.test("anonymous cannot execute settings RPC or trigger function", () =>
      asRole(db, "anon", { role: "anon" }, async () => {
        await denied(db, () => update(db, { name: "Attack" }, { name: "x" }));
        await denied(db, () => db.query("select validate_clinic_settings()"));
      }),
    );
  } finally {
    await db.close();
  }
});

test("shared input validation: IANA zones, canonical dirty fields and structured hours", () => {
  for (const zone of ["UTC", "Asia/Tokyo", "America/New_York", "Europe/London", "Etc/GMT+3"])
    assert.ok(validTimeZone(zone));
  for (const zone of ["EST", "GMT+3", "", "bad/zone"]) assert.equal(validTimeZone(zone), false);
  const original = {
    name: "Clinic",
    phone: null,
    email: "clinic@example.test",
    timezone: "UTC",
    ...Object.fromEntries(
      [
        "localized_name",
        "clinic_type",
        "website",
        "fallback_phone",
        "address",
        "city",
        "country",
        "directions",
        "parking_information",
        "receptionist_name",
        "receptionist_localized_name",
        "opening_hours",
      ].map((k) => [k, null]),
    ),
  };
  const draft = settingsDraft(original);
  assert.deepEqual(changedSettings(original, normalizeSettings(draft)), {});
  const legacy = { ...original, phone: "legacy extension" };
  const legacyDraft = settingsDraft(legacy);
  legacyDraft.name = "New name";
  assert.deepEqual(changedSettings(legacy, normalizeSettings(legacyDraft, legacy)), {
    name: "New name",
  });
  draft.phone = " +12025550100 ";
  assert.deepEqual(changedSettings(original, normalizeSettings(draft)), { phone: "+12025550100" });
  draft.email = " ";
  assert.equal(normalizeSettings(draft).email, null);
  draft.timezone = "bad/zone";
  assert.throws(() => normalizeSettings(draft), /valid IANA/);
  assert.deepEqual(validateHours(hours), hours);
  assert.equal(validateHours(null), null);
  for (const value of [[], {}, { days: [] }, { days: Array(7).fill({ day: 0, periods: [] }) }])
    assert.throws(() => validateHours(value));
});
