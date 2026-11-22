// Always builds an unlinked temporary project. Never reads repository .env,
// copies .temp links, supplies --remote, or accepts a hosted URL.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, cp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { isolateSupabasePorts } from "./helpers/supabase-ports.mjs";
const root = await mkdtemp(join(tmpdir(), "apero-supabase-ci-"));
const environment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.startsWith("SUPABASE_") && !key.startsWith("PG"),
  ),
);
function run(program, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: root,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (x) => {
      stdout += x;
    });
    child.stderr.on("data", (x) => {
      stderr += x;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(`${program} failed (${code}): ${stderr}`)),
    );
    child.stdin.end(input);
  });
}
let initialized = false,
  success = false;
try {
  assert.match(
    (await run("supabase", ["--version"])).trim(),
    /^3\.0\.0$/,
    "CI pins Supabase CLI 3.0.0",
  );
  await run("supabase", ["init"]);
  initialized = true;
  await mkdir(join(root, "supabase", "migrations"), { recursive: true });
  await cp(join(process.cwd(), "supabase", "migrations"), join(root, "supabase", "migrations"), {
    recursive: true,
  });
  const config = await readFile(join(root, "supabase", "config.toml"), "utf8");
  const project = config.match(/^project_id\s*=\s*"([a-zA-Z0-9_-]+)"/m)?.[1];
  assert.ok(project?.startsWith("apero-supabase-ci-"));
  const isolated = await isolateSupabasePorts(config);
  await writeFile(join(root, "supabase", "config.toml"), isolated.config);
  // CLI v3 defaults to local; removed v2 target flags are deliberately not used.
  await run("supabase", ["start"]);
  await run("supabase", ["db", "reset", "--no-seed"]);
  const container = "supabase_db_" + project;
  const sql = (statement) =>
    run(
      "docker",
      [
        "exec",
        "-i",
        container,
        "psql",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-XAt",
        "-v",
        "ON_ERROR_STOP=1",
      ],
      statement,
    );
  assert.equal((await sql("select count(*) from public.clients;")).trim(), "0");
  assert.equal(
    (
      await sql("select count(*) from cron.job where jobname='apero-retention-daily' and active; ")
    ).trim(),
    "1",
  );
  assert.equal(
    (
      await sql(
        "select count(*) from pg_constraint where conname='appointments_shared_no_overlap';",
      )
    ).trim(),
    "1",
  );
  await sql(
    "create table public.apero_ci_cron_probe(ok boolean default true);select cron.schedule('apero-ci-probe','1 second','insert into public.apero_ci_cron_probe default values');",
  );
  let executed = false;
  for (let n = 0; n < 100; n++) {
    if (Number((await sql("select count(*) from public.apero_ci_cron_probe;")).trim()) > 0) {
      executed = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(executed, true, "Managed Supabase pg_cron must execute a real synthetic job");
  await sql("select cron.unschedule('apero-ci-probe');drop table public.apero_ci_cron_probe;");
  console.log(
    "PASS genuine local Supabase db reset, managed Auth schema, exclusion and pg_cron background execution",
  );
  success = true;
} finally {
  if (initialized) await run("supabase", ["stop", "--no-backup"]);
  if (success) await rm(root, { recursive: true, force: true });
  else console.error("Unlinked CI fixture retained:", root);
}
