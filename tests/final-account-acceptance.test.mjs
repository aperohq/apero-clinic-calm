// Release acceptance: complete native schema; synthetic dashboard operations only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, readdir } from "node:fs/promises";
import postgres from "postgres";
import { disposablePostgres } from "../scripts/helpers/disposable-postgres.mjs";

test(
  "Final native Manager and dashboard appointment acceptance",
  { timeout: 120000 },
  async (t) => {
    const cluster = await disposablePostgres({ cron: true, database: "apero_final_account" });
    const sql = postgres({ ...cluster, max: 8, onnotice() {} });
    const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    let success = false;
    const clinics = [],
      staff = [],
      clients = [];
    async function actor(user, fn, role = "authenticated") {
      return sql.begin(async (tx) => {
        await tx.unsafe(`set local role ${role}`);
        await tx`select set_config('request.jwt.claims',${JSON.stringify({ role, sub: user, user_metadata: { role: "owner", clinic_id: id(999) } })},true)`;
        return fn(tx);
      });
    }
    const denied = (fn) => assert.rejects(fn, (e) => ["42501", "P0001", "22023"].includes(e.code));
    try {
      await sql.unsafe(`create role anon nologin nobypassrls;create role authenticated nologin nobypassrls;create role service_role nologin bypassrls;
      create schema auth;create table auth.users(id uuid primary key,email text,invited_at timestamptz,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
      grant usage on schema public,auth to anon,authenticated,service_role;
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)$$;
      create function auth.uid() returns uuid language sql stable as $$select nullif(auth.jwt()->>'sub','')::uuid$$;
      alter default privileges in schema public grant all on tables to anon,authenticated,service_role;`);
      const setup = await sql.reserve();
      try {
        for (const file of (await readdir("supabase/migrations"))
          .filter((f) => f.endsWith(".sql"))
          .sort())
          await setup.unsafe(await readFile(`supabase/migrations/${file}`, "utf8"));
      } finally {
        setup.release();
      }
      const doc = await readFile("docs/onboarding/ADMINISTRATIVE_INTAKE.md", "utf8");
      const base = JSON.parse(doc.match(/```json\n([\s\S]*?)\n```/)[1]);
      for (let i = 0; i < 2; i++) {
        const owner = id(100 + i),
          manager = id(200 + i),
          receptionist = id(300 + i);
        for (const user of [owner, manager, receptionist])
          await sql`insert into auth.users(id,email,email_confirmed_at) values(${user},${`${user}@synthetic.test`},now())`;
        const payload = structuredClone(base);
        payload.owner_auth_id = owner;
        payload.clinic.phone = `+9655555012${i}`;
        payload.practitioners[0].availability = Array.from({ length: 5 }, (_, day) => ({
          day,
          start: "09:00",
          end: "17:00",
        }));
        const [{ cid }] = await actor(
          owner,
          (tx) => tx`select provision_clinic(${`final-acceptance-${i}`},${tx.json(payload)}) cid`,
          "service_role",
        );
        clinics.push(cid);
        await sql`insert into profiles(id,auth_user_id,clinic_id,full_name,email,role) values(${id(400 + i)},${manager},${cid},'Synthetic Manager',${`${manager}@synthetic.test`},'manager'),(${id(500 + i)},${receptionist},${cid},'Synthetic Staff',${`${receptionist}@synthetic.test`},'staff')`;
        staff.push((await sql`select id from staff where clinic_id=${cid}`)[0].id);
        const [{ id: client }] =
          await sql`insert into clients(clinic_id,full_name,phone) values(${cid},'Synthetic acceptance client','55550000') returning id`;
        clients.push(client);
      }
      const date = "2040-01-02",
        start = "2040-01-02T06:00:00Z",
        end = "2040-01-02T06:45:00Z";
      const book = (
        tx,
        aid,
        offset = 0,
        cid = clinics[0],
        sid = staff[0],
        client = clients[0],
        service = "Consultation",
      ) =>
        tx`insert into appointments(id,clinic_id,staff_id,client_id,service,start_time,end_time) values(${aid},${cid},${sid},${client},${service},${new Date(Date.parse(start) + offset * 60000)},${new Date(Date.parse(end) + offset * 60000)}) returning id`;
      for (const [role, user] of [
        ["owner", id(100)],
        ["manager", id(200)],
        ["staff", id(300)],
      ]) {
        await t.test(
          `${role}: native booking, Kuwait time, reschedule, cancellation and rejected-write integrity`,
          async () => {
            const aid = id(role === "owner" ? 600 : role === "manager" ? 601 : 602);
            const slots = await actor(
              user,
              (tx) =>
                tx`select * from appointment_available_slots(${clinics[0]},${staff[0]},'Consultation',${date}::date,null)`,
            );
            assert.equal(new Date(slots[0].start_time).toISOString(), start.replace("Z", ".000Z"));
            await actor(user, (tx) => book(tx, aid));
            await assert.rejects(
              actor(user, (tx) => book(tx, aid)),
              /unavailable|duplicate/i,
            );
            await assert.rejects(
              actor(user, (tx) =>
                book(tx, id(610), 0, clinics[0], staff[0], clients[0], "Unsupported"),
              ),
            );
            await assert.rejects(actor(user, (tx) => book(tx, id(611), 0, clinics[0], staff[1])));
            await assert.rejects(
              actor(user, (tx) => book(tx, id(612), 0, clinics[0], staff[0], clients[1])),
            );
            await actor(
              user,
              (tx) =>
                tx`update appointments set start_time=start_time+interval '90 minutes',end_time=end_time+interval '90 minutes' where id=${aid}`,
            );
            const [{ n }] =
              await sql`select count(*)::int n from appointments where clinic_id=${clinics[0]}`;
            assert.equal(n, role === "owner" ? 1 : role === "manager" ? 2 : 3);
            await actor(
              user,
              (tx) => tx`update appointments set status='Cancelled' where id=${aid}`,
            );
            assert.equal(
              (await sql`select status from appointments where id=${aid}`)[0].status,
              "Cancelled",
            );
          },
        );
      }
      await t.test(
        "Manager: both clinics enforce horizontal reads, writes and RPC denial",
        async () => {
          for (let i = 0; i < 2; i++) {
            const user = id(200 + i),
              foreign = 1 - i;
            assert.equal(
              (
                await actor(
                  user,
                  (tx) => tx`select id from clients where clinic_id=${clinics[foreign]}`,
                )
              ).length,
              0,
            );
            assert.equal(
              (
                await actor(
                  user,
                  (tx) =>
                    tx`update clients set full_name='Forged' where id=${clients[foreign]} returning id`,
                )
              ).length,
              0,
            );
            await denied(
              actor(
                user,
                (tx) =>
                  tx`select appointment_available_slots(${clinics[foreign]},${staff[foreign]},'Consultation',${date}::date,null)`,
              ),
            );
            await denied(
              actor(user, (tx) => tx`select set_clinic_member_role(${id(500 + i)},'manager')`),
            );
            await denied(actor(user, (tx) => tx`select revoke_clinic_member(${id(500 + i)})`));
            await denied(actor(user, (tx) => tx`select reactivate_clinic_member(${id(500 + i)})`));
            await denied(
              actor(user, (tx) => tx`update profiles set role='owner' where auth_user_id=${user}`),
            );
            await denied(
              actor(user, (tx) => tx`select clinic_activation_readiness(${clinics[i]})`),
            );
            await denied(actor(user, (tx) => tx`select provision_clinic('forged','{}')`));
          }
        },
      );
      await t.test(
        "Manager: own practitioner schedule management succeeds and owner configuration remains denied",
        async () => {
          const user = id(200);
          assert.equal(
            (
              await actor(
                user,
                (tx) =>
                  tx`update staff set specialty='Synthetic Dental' where id=${staff[0]} returning id`,
              )
            ).length,
            1,
          );
          assert.equal(
            (
              await actor(
                user,
                (tx) =>
                  tx`update staff_availability set end_time='16:00' where staff_id=${staff[0]} returning id`,
              )
            ).length,
            5,
          );
          assert.equal(
            (
              await actor(
                user,
                (tx) =>
                  tx`update clinics set phone='+96555559999' where id=${clinics[0]} returning id`,
              )
            ).length,
            0,
          );
          assert.equal(
            (await sql`select phone from clinics where id=${clinics[0]}`)[0].phone,
            "+96555550120",
          );
        },
      );
      await t.test(
        "Native simultaneous dashboard bookings persist exactly one winner",
        async () => {
          const results = await Promise.allSettled([
            actor(id(100), (tx) => book(tx, id(700), 180)),
            actor(id(200), (tx) => book(tx, id(701), 180)),
          ]);
          assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
          assert.equal(results.filter((r) => r.status === "rejected").length, 1);
          assert.equal(
            (
              await sql`select count(*)::int n from appointments where id in (${id(700)},${id(701)})`
            )[0].n,
            1,
          );
        },
      );
      await t.test(
        "Revoked Manager retained claims immediately lose database access; Owner restoration retains Manager role",
        async () => {
          await actor(id(100), (tx) => tx`select revoke_clinic_member(${id(400)})`);
          assert.equal((await actor(id(200), (tx) => tx`select id from clients`)).length, 0);
          await denied(
            actor(
              id(200),
              (tx) =>
                tx`select appointment_available_slots(${clinics[0]},${staff[0]},'Consultation',${date}::date,null)`,
            ),
          );
          await actor(id(100), (tx) => tx`select reactivate_clinic_member(${id(400)})`);
          assert.equal(
            (await actor(id(200), (tx) => tx`select current_profile_role() role`))[0].role,
            "manager",
          );
        },
      );
      await t.test(
        "Blank English/Arabic intake values fail atomically without orphaned clinic records",
        async () => {
          const owner = id(900);
          await sql`insert into auth.users(id,email,email_confirmed_at) values(${owner},'invalid-intake@synthetic.test',now())`;
          const before = (await sql`select count(*)::int n from clinics`)[0].n;
          for (const field of ["name", "localized_name"]) {
            const payload = structuredClone(base);
            payload.owner_auth_id = owner;
            payload.clinic.phone = "+96555550999";
            payload.clinic[field] = "   ";
            await assert.rejects(
              actor(
                owner,
                (tx) => tx`select provision_clinic(${`invalid-${field}`},${tx.json(payload)})`,
                "service_role",
              ),
            );
            assert.equal((await sql`select count(*)::int n from clinics`)[0].n, before);
            assert.equal(
              (await sql`select count(*)::int n from profiles where auth_user_id=${owner}`)[0].n,
              0,
            );
          }
        },
      );
      await t.test(
        "Anonymous direct availability and membership mutations are denied",
        async () => {
          await denied(
            actor(
              id(100),
              (tx) =>
                tx`select appointment_available_slots(${clinics[0]},${staff[0]},'Consultation',${date}::date,null)`,
              "anon",
            ),
          );
          await denied(
            actor(id(100), (tx) => tx`select set_clinic_member_role(${id(500)},'manager')`, "anon"),
          );
        },
      );
      success = true;
    } finally {
      await sql.end({ timeout: 2 });
      await cluster.close(success);
    }
  },
);
