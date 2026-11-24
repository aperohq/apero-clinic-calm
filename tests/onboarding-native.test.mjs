import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, readdir } from "node:fs/promises";
import postgres from "postgres";
import { disposablePostgres } from "../scripts/helpers/disposable-postgres.mjs";

// Native PostgreSQL, disposable Unix-socket-only cluster. No DATABASE_URL,
// provider clients, emails, external calls or real patient records are used.
test(
  "Native onboarding migrations and concurrent lifecycle admission",
  { timeout: 120_000 },
  async (t) => {
    const cluster = await disposablePostgres({ cron: true, database: "apero_onboarding_native" });
    const sql = postgres({ ...cluster, max: 8, onnotice() {} });
    const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const clinic = id(100),
      owner = id(101),
      staff = id(104),
      client = id(103),
      appointment = id(105),
      key = id(800);
    let success = false;
    const connections = [];
    async function transaction(role = "service_role", user = null) {
      const tx = await sql.reserve();
      connections.push(tx);
      await tx.unsafe("begin;set local statement_timeout='8s'");
      await tx.unsafe(`set local role ${role}`);
      await tx`select set_config('request.jwt.claims',${JSON.stringify({ role, ...(user ? { sub: user } : {}) })},true)`;
      const [{ pid }] = await tx`select pg_backend_pid() pid`;
      return { tx, pid };
    }
    async function release(tx, commit = false) {
      try {
        await tx.unsafe(commit ? "commit" : "rollback");
      } finally {
        tx.release();
        connections.splice(connections.indexOf(tx), 1);
      }
    }
    async function blocked(pid, blocker) {
      for (let n = 0; n < 100; n++) {
        const [{ waiting }] =
          await sql`select ${blocker}::int=any(pg_blocking_pids(${pid}::int)) waiting`;
        if (waiting) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.fail(`Backend ${pid} did not wait for synthetic blocker ${blocker}`);
    }
    async function reset() {
      await sql.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims','{"role":"service_role"}',true)`;
        await tx`update clinic_onboarding set lifecycle='activated' where clinic_id=${clinic}`;
        await tx`delete from integration_requests where key_id=${key}`;
        await tx`delete from integration_keys where id=${key}`;
        await tx`insert into integration_keys(id,clinic_id,name,key_hash,prefix,scopes) values(${key},${clinic},'Synthetic native key',${"a".repeat(64)},'synthetic',array['appointments:write'])`;
        await tx`delete from appointments where id=${appointment}`;
        await tx`insert into appointments(id,clinic_id,staff_id,client_id,service,start_time,end_time,status) values(${appointment},${clinic},${staff},${client},'Consultation','2030-01-07T09:00Z','2030-01-07T09:45Z','Booked')`;
      });
    }
    try {
      const setup = await sql.reserve();
      try {
        await setup.unsafe(`create role anon nologin nobypassrls;create role authenticated nologin nobypassrls;create role service_role nologin bypassrls;
        create schema auth;create table auth.users(id uuid primary key,email text,invited_at timestamptz,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
        grant usage on schema public,auth to anon,authenticated,service_role;
        create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)$$;
        create function auth.uid() returns uuid language sql stable as $$select nullif(auth.jwt()->>'sub','')::uuid$$;
        alter default privileges in schema public grant all on tables to anon,authenticated,service_role;`);
        const files = (await readdir("supabase/migrations"))
          .filter((f) => f.endsWith(".sql"))
          .sort();
        for (const file of files)
          await setup.unsafe(await readFile(`supabase/migrations/${file}`, "utf8"));
        await t.test("Complete migration chain applies to real PostgreSQL", async () => {
          assert.equal((await setup`select count(*)::int n from clients`)[0].n, 0);
          assert.ok(files.filter((f) => f.startsWith("20261124")).length >= 5);
          const [server] =
            await setup`select current_setting('server_version') version,inet_server_addr() address`;
          assert.equal(server.address, null);
          console.log(
            `Native PostgreSQL ${server.version}; ${files.length} local migrations applied`,
          );
        });
        await setup`select set_config('request.jwt.claims','{"role":"service_role"}',false)`;
        await setup`insert into auth.users(id,email,email_confirmed_at) values(${owner},'owner@synthetic.test',now())`;
        await setup`insert into clinics(id,name,timezone) values(${clinic},'Synthetic native clinic','UTC')`;
        await setup`insert into profiles(id,auth_user_id,clinic_id,full_name,email,role) values(${id(102)},${owner},${clinic},'Synthetic Owner','owner@synthetic.test','owner')`;
        await setup`insert into clinic_onboarding(clinic_id,submission_key,payload,synthetic,lifecycle) values(${clinic},'native-synthetic-fixture','{}',true,'activated')`;
        await setup`insert into staff(id,clinic_id,full_name,specialty,services) values(${staff},${clinic},'Synthetic Practitioner','General',array['Consultation'])`;
        await setup`insert into staff_availability(clinic_id,staff_id,day_of_week,start_time,end_time) select ${clinic},${staff},d,'00:00','23:59' from generate_series(0,6) d`;
        await setup`insert into clients(id,clinic_id,full_name,phone) values(${client},${clinic},'Synthetic Patient','12345678')`;
        await setup`insert into appointments(id,clinic_id,staff_id,client_id,service,start_time,end_time,status) values(${appointment},${clinic},${staff},${client},'Consultation','2030-01-07T09:00Z','2030-01-07T09:45Z','Booked')`;
      } finally {
        await setup`select set_config('request.jwt.claims','',false)`;
        setup.release();
      }
      await t.test(
        "Trusted intake provisions atomically with native retry and Unicode preservation",
        async () => {
          const markdown = await readFile("docs/onboarding/ADMINISTRATIVE_INTAKE.md", "utf8");
          const payload = JSON.parse(markdown.match(/```json\n([\s\S]*?)\n```/)[1]);
          payload.owner_auth_id = id(910);
          await sql`insert into auth.users(id,email,email_confirmed_at) values(${id(910)},'intake@synthetic.test',now())`;
          const service = await transaction();
          try {
            const [created] =
              await service.tx`select provision_clinic('native-documented-intake',${service.tx.json(payload)}) id`;
            const [retry] =
              await service.tx`select provision_clinic('native-documented-intake',${service.tx.json(payload)}) id`;
            assert.equal(created.id, retry.id);
            const [readiness] =
              await service.tx`select clinic_activation_readiness(${created.id}) result`;
            assert.equal(readiness.result.state, "onboarding_incomplete");
            assert.deepEqual(readiness.result.failures, [
              "Synthetic clinic cannot activate; provision a separate real clinic",
            ]);
            await release(service.tx, true);
            assert.equal(
              (await sql`select localized_name from clinics where id=${created.id}`)[0]
                .localized_name,
              "عيادة اختبار",
            );
            assert.equal(
              (await sql`select count(*)::int n from profiles where clinic_id=${created.id}`)[0].n,
              1,
            );
            assert.equal(
              (
                await sql`select count(*)::int n from clinic_onboarding_audit where clinic_id=${created.id}`
              )[0].n,
              1,
            );
            await sql`delete from clinic_onboarding where clinic_id=${created.id}`;
            const registrar = await transaction();
            try {
              const [registered] =
                await registrar.tx`select register_existing_clinic_intake(${created.id},'native-existing-intake',${registrar.tx.json(payload)},'Synthetic existing clinic acceptance') id`;
              const [repeated] =
                await registrar.tx`select register_existing_clinic_intake(${created.id},'native-existing-intake',${registrar.tx.json(payload)},'Synthetic existing clinic acceptance') id`;
              assert.equal(registered.id, created.id);
              assert.equal(repeated.id, created.id);
              await release(registrar.tx, true);
              assert.equal(
                (await sql`select count(*)::int n from profiles where clinic_id=${created.id}`)[0]
                  .n,
                1,
              );
            } catch (error) {
              if (connections.includes(registrar.tx)) await release(registrar.tx);
              throw error;
            }
          } catch (error) {
            if (connections.includes(service.tx)) await release(service.tx);
            throw error;
          }
        },
      );
      await t.test(
        "Owner-first lifecycle locks avoid inversion with an in-flight team role change",
        async () => {
          await reset();
          const memberUser = id(98),
            memberProfile = id(99);
          await sql`insert into auth.users(id,email,email_confirmed_at) values(${memberUser},'native-member@synthetic.test',now())`;
          await sql`insert into profiles(id,auth_user_id,clinic_id,full_name,email,role) values(${memberProfile},${memberUser},${clinic},'Native Manager','native-member@synthetic.test','manager')`;
          const actor = await transaction("authenticated", owner),
            suspender = await transaction();
          // Pause at the existing Owner RPC's first row lock. Target UUID sorts
          // before the Owner UUID; lifecycle must still lock the Owner first.
          await actor.tx`select id from profiles where auth_user_id=${owner} for update`;
          const suspending =
            suspender.tx`select decide_clinic_lifecycle(${clinic},'suspend','Synthetic owner/member lock ordering')`.then(
              () => null,
              (error) => error,
            );
          await blocked(suspender.pid, actor.pid);
          await actor.tx`select set_clinic_member_role(${memberProfile},'staff')`;
          await release(actor.tx, true);
          assert.equal(await suspending, null);
          await release(suspender.tx, true);
          assert.equal(
            (await sql`select role from profiles where id=${memberProfile}`)[0].role,
            "staff",
          );
        },
      );
      await t.test(
        "In-flight API mutation finishes before suspension without deadlock",
        async () => {
          await reset();
          const writer = await transaction(),
            suspender = await transaction();
          await writer.tx`select integration_mutate(${key},'native-first-request',${writer.tx.json({ action: "cancel", appointment_id: appointment })})`;
          const suspending =
            suspender.tx`select decide_clinic_lifecycle(${clinic},'suspend','Synthetic concurrency test')`.then(
              () => null,
              (error) => error,
            );
          // Start the thenable now, then observe genuine native lock blocking.
          await blocked(suspender.pid, writer.pid);
          await release(writer.tx, true);
          assert.equal(await suspending, null);
          await release(suspender.tx, true);
          assert.equal(
            (await sql`select status from appointments where id=${appointment}`)[0].status,
            "Cancelled",
          );
          assert.ok(
            (await sql`select revoked_at from integration_keys where id=${key}`)[0].revoked_at,
          );
        },
      );
      await t.test(
        "API mutation waiting behind suspension rechecks revoked credential",
        async () => {
          await reset();
          const suspender = await transaction(),
            writer = await transaction();
          await suspender.tx`select decide_clinic_lifecycle(${clinic},'suspend','Synthetic concurrency test')`;
          const writing =
            writer.tx`select integration_mutate(${key},'native-second-request',${writer.tx.json({ action: "cancel", appointment_id: appointment })})`.then(
              () => null,
              (error) => error,
            );
          await blocked(writer.pid, suspender.pid);
          await release(suspender.tx, true);
          assert.equal((await writing)?.code, "42501");
          await release(writer.tx);
          assert.equal(
            (await sql`select status from appointments where id=${appointment}`)[0].status,
            "Booked",
          );
        },
      );
      await t.test(
        "Authenticated configuration write rechecks lifecycle after stale RLS snapshot",
        async () => {
          await reset();
          const suspender = await transaction(),
            writer = await transaction("authenticated", owner);
          await suspender.tx`select decide_clinic_lifecycle(${clinic},'suspend','Synthetic snapshot test')`;
          const writing =
            writer.tx`update staff set full_name='Unpermitted stale write' where id=${staff}`.then(
              () => null,
              (error) => error,
            );
          await blocked(writer.pid, suspender.pid);
          await release(suspender.tx, true);
          assert.equal((await writing)?.code, "42501");
          await release(writer.tx);
          assert.equal(
            (await sql`select full_name from staff where id=${staff}`)[0].full_name,
            "Synthetic Practitioner",
          );
        },
      );
      await t.test(
        "Operator invitation waiting behind suspension cannot reserve identity",
        async () => {
          await reset();
          const suspender = await transaction(),
            operator = await transaction();
          await suspender.tx`select decide_clinic_lifecycle(${clinic},'suspend','Synthetic operator snapshot test')`;
          const reserving =
            operator.tx`select reserve_clinic_invitation(null,${clinic},'pending@synthetic.test','operator_invite',null)`.then(
              () => null,
              (error) => error,
            );
          await blocked(operator.pid, suspender.pid);
          await release(suspender.tx, true);
          assert.equal((await reserving)?.code, "42501");
          await release(operator.tx);
          assert.equal(
            (
              await sql`select count(*)::int n from clinic_invitation_claims where email='pending@synthetic.test'`
            )[0].n,
            0,
          );
        },
      );
      await t.test(
        "Legacy offboarding denies active identities, operator enrollment and in-flight API admission",
        async () => {
          await reset();
          await sql`insert into clinic_offboarding(clinic_id,state) values(${clinic},'grace')`;
          assert.equal(
            (await sql`select revoked_at from profiles where auth_user_id=${owner}`)[0].revoked_at,
            null,
          );
          const reader = await transaction("authenticated", owner);
          try {
            assert.equal((await reader.tx`select current_clinic_id() id`)[0].id, null);
            assert.equal((await reader.tx`select id from clients`).length, 0);
          } finally {
            await release(reader.tx);
          }
          for (const action of [
            (tx) =>
              tx`select reserve_clinic_invitation(null,${clinic},'blocked@synthetic.test','operator_invite',null)`,
            (tx) =>
              tx`select integration_mutate(${key},'offboarding-request',${tx.json({ action: "cancel", appointment_id: appointment })})`,
          ]) {
            const caller = await transaction();
            try {
              await assert.rejects(action(caller.tx), (error) => error.code === "42501");
            } finally {
              await release(caller.tx);
            }
          }
          assert.equal(
            (await sql`select status from appointments where id=${appointment}`)[0].status,
            "Booked",
          );
        },
      );
      await t.test(
        "Demo FKs, note attribution and approved erasure preserve new audits",
        async () => {
          const cid = id(9000),
            uid = id(9001),
            patient = id(9003),
            request = id(9004),
            note = id(9005);
          await sql`insert into auth.users(id,email,email_confirmed_at) values(${uid},'erasure@synthetic.test',now())`;
          await sql`insert into clinics(id,name) values(${cid},'Synthetic erasure clinic')`;
          const [profile] =
            await sql`insert into profiles(auth_user_id,clinic_id,full_name,email,role) values(${uid},${cid},'Synthetic erasure owner','erasure@synthetic.test','owner') returning id`;
          await sql`insert into clinic_onboarding(clinic_id,submission_key,payload) values(${cid},'native-erasure-fixture','{}')`;
          await sql`insert into clinic_onboarding_audit(clinic_id,event,reason) values(${cid},'provisioned','Synthetic erasure fixture')`;
          await sql`insert into clients(id,clinic_id,full_name,phone) values(${patient},${cid},'Synthetic historical patient','12345678')`;
          await sql`insert into client_notes(id,clinic_id,client_id,author_profile_id,note) values(${note},${cid},${patient},${profile.id},'Synthetic historical attribution')`;
          await sql`insert into demo_call_sessions(request_id,clinic_id,auth_user_id) values(${request},${cid},${uid})`;
          await assert.rejects(
            sql`delete from auth.users where id=${uid}`,
            (error) => error.code === "23503",
          );
          await assert.rejects(
            sql`select retention_begin_offboarding(${cid})`,
            /Retention approval required/,
          );
          await sql`update retention_control set mode='enabled',approved_at=now(),restore_ledger_ready=true`;
          await sql`select retention_begin_offboarding(${cid})`;
          assert.ok(
            (await sql`select revoked_at from profiles where id=${profile.id}`)[0].revoked_at,
          );
          await sql`update clinic_offboarding set grace_until=now()-interval '1 day',telephony_stopped_verified=true,provider_inventory_verified=true,secrets_revoked_verified=true where clinic_id=${cid}`;
          await assert.rejects(
            sql`select retention_offboard_batch(${cid},false,100)`,
            /Finish active demo calls/,
          );
          await sql`update demo_call_sessions set ended=true where request_id=${request}`;
          await sql`delete from auth.users where id=${uid}`;
          assert.equal(
            (await sql`select auth_user_id from demo_call_sessions where request_id=${request}`)[0]
              .auth_user_id,
            null,
          );
          const [retainedNote] =
            await sql`select author_profile_id,note from client_notes where id=${note}`;
          assert.equal(retainedNote.author_profile_id, null);
          assert.equal(retainedNote.note, "Synthetic historical attribution");
          await sql`insert into clinic_retention(clinic_id,legal_hold) values(${cid},true) on conflict(clinic_id) do update set legal_hold=true`;
          await assert.rejects(
            sql`select retention_offboard_batch(${cid},false,100)`,
            /Legal hold/,
          );
          await sql`update clinic_retention set legal_hold=false where clinic_id=${cid}`;
          assert.equal(
            (await sql`select retention_offboard_batch(${cid},false,100) value`)[0].value.state,
            "awaiting_durable_ledger",
          );
          let complete = false;
          for (let n = 0; n < 12; n++) {
            await sql`update retention_deletion_ledger set durable_at=now() where clinic_id=${cid}`;
            if (
              (await sql`select retention_offboard_batch(${cid},false,100) value`)[0].value
                .state === "complete"
            ) {
              complete = true;
              break;
            }
          }
          assert.ok(
            complete,
            "Approved synthetic erasure completes without new audit FKs blocking it",
          );
          assert.equal(
            (await sql`select count(*)::int n from clinic_onboarding where clinic_id=${cid}`)[0].n,
            0,
          );
          assert.equal(
            (await sql`select count(*)::int n from demo_call_sessions where clinic_id=${cid}`)[0].n,
            0,
          );
          assert.equal(
            (
              await sql`select count(*)::int n from clinic_onboarding_audit where clinic_id=${cid}`
            )[0].n,
            1,
          );
          assert.equal(
            (
              await sql`select count(*)::int n from clinic_membership_audit where clinic_id=${cid}`
            )[0].n,
            1,
          );
          assert.equal((await sql`select count(*)::int n from clinics where id=${clinic}`)[0].n, 1);
        },
      );
      success = true;
    } finally {
      for (const tx of [...connections]) await release(tx).catch(() => {});
      await sql.end({ timeout: 2 });
      await cluster.close(success);
    }
  },
);
