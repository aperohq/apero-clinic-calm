import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PGlite } from "@electric-sql/pglite";
test("offline intake artifact quotes input, preserves Unicode, rolls back and refuses overwrite", async () => {
  const dir = await mkdtemp(join(tmpdir(), "apero-intake-"));
  const db = new PGlite();
  try {
    const input = join(dir, "input.json"),
      output = join(dir, "dry-run.sql");
    const key = "intake-key'); drop table marker; --\\";
    const payload = { clinic: { name: "عيادة O'Brien\\" } };
    await writeFile(input, JSON.stringify(payload));
    const run = () =>
      spawnSync(process.execPath, ["scripts/onboarding/prepare-intake.mjs", input, key, output], {
        encoding: "utf8",
        env: { PATH: process.env.PATH },
      });
    assert.equal(run().status, 0);
    const sql = await readFile(output, "utf8");
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.equal(run().status, 1);
    await db.exec(
      "create table marker(id int);create function public.provision_clinic(k text,p jsonb) returns uuid language plpgsql as $$begin insert into marker values(1);if k is null or p->'clinic'->>'name' is null then raise exception 'bad';end if;return gen_random_uuid();end$$;",
    );
    await db.exec(sql);
    assert.equal((await db.query("select count(*)::int n from marker")).rows[0].n, 0);
    assert.match(sql, /عيادة/);
    assert.match(sql, /rollback;/);
    const existingOutput = join(dir, "existing.sql"),
      existingId = "00000000-0000-4000-8000-000000000100";
    assert.equal(
      spawnSync(
        process.execPath,
        ["scripts/onboarding/prepare-intake.mjs", input, key, existingOutput, existingId],
        { encoding: "utf8", env: { PATH: process.env.PATH } },
      ).status,
      0,
    );
    await db.exec(
      "create function public.register_existing_clinic_intake(cid uuid,k text,p jsonb,reason text) returns uuid language plpgsql as $$begin insert into marker values(2);return cid;end$$",
    );
    const existingSql = await readFile(existingOutput, "utf8");
    assert.match(existingSql, /register_existing_clinic_intake/);
    assert.match(existingSql, /activation-gated/);
    for (const invalidId of ["", "not-a-clinic-uuid"]) {
      const rejectedOutput = join(dir, "rejected.sql");
      assert.equal(
        spawnSync(
          process.execPath,
          ["scripts/onboarding/prepare-intake.mjs", input, key, rejectedOutput, invalidId],
          { encoding: "utf8", env: { PATH: process.env.PATH } },
        ).status,
        1,
      );
      await assert.rejects(readFile(rejectedOutput, "utf8"), (error) => error.code === "ENOENT");
    }
    await db.exec(existingSql);
    assert.equal((await db.query("select count(*)::int n from marker")).rows[0].n, 0);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
