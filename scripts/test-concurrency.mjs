// Local disposable PostgreSQL only. No DATABASE_URL or hosted credentials.
import { mkdtemp, mkdir, writeFile, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
const bin = (name) =>
  process.env.APERO_TEST_PG_BIN ? join(process.env.APERO_TEST_PG_BIN, name) : name;
const probe = spawnSync(bin("initdb"), ["--version"], { encoding: "utf8" });
if (probe.error || probe.status !== 0) {
  console.error(
    "Native integration requires local PostgreSQL tools. Set APERO_TEST_PG_BIN; no remote database is used.",
  );
  process.exit(1);
}
const cluster = await mkdtemp(join(tmpdir(), "apero-concurrency-"));
let started = false;
function run(tool, args) {
  const r = spawnSync(bin(tool), args, { encoding: "utf8" });
  if (r.error || r.status !== 0) throw new Error(`${tool} failed: ${r.error?.message ?? r.stderr}`);
  return r;
}
try {
  const port = await new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
  await mkdir(join(cluster, "socket"));
  await writeFile(
    join(cluster, ".apero-disposable.json"),
    JSON.stringify({ database: "apero_concurrency_acceptance", port }),
    { mode: 0o600 },
  );
  run("initdb", [
    "-D",
    join(cluster, "data"),
    "-U",
    "apero_test",
    "--auth=trust",
    "--encoding=UTF8",
    "--no-locale",
  ]);
  const windows = process.platform === "win32";
  const options = `-F -p ${port} -c listen_addresses=${windows ? "127.0.0.1" : "''"}${windows ? "" : ` -k "${join(cluster, "socket")}"`}`;
  run("pg_ctl", [
    "-D",
    join(cluster, "data"),
    "-l",
    join(cluster, "server.log"),
    "-o",
    options,
    "-w",
    "start",
  ]);
  started = true;
  run("createdb", [
    "-h",
    windows ? "127.0.0.1" : join(cluster, "socket"),
    "-p",
    String(port),
    "-U",
    "apero_test",
    "apero_concurrency_acceptance",
  ]);
  const result = spawnSync(process.execPath, ["tests/appointments-concurrency.test.mjs"], {
    stdio: "inherit",
    env: { ...process.env, APERO_TEST_CONCURRENCY_CLUSTER: cluster },
  });
  process.exitCode = result.error ? 1 : (result.status ?? 1);
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  if (started) {
    try {
      run("pg_ctl", ["-D", join(cluster, "data"), "-m", "immediate", "-w", "stop"]);
    } catch {
      process.exitCode = 1;
    }
  }
  if (process.env.APERO_TEST_RESULTS_DIR) {
    await mkdir(process.env.APERO_TEST_RESULTS_DIR, { recursive: true });
    try {
      await copyFile(
        join(cluster, "acceptance-evidence.json"),
        join(process.env.APERO_TEST_RESULTS_DIR, "concurrency.json"),
      );
    } catch {
      process.exitCode = 1;
    }
  }
  // Keep failure evidence locally; only remove our freshly created successful fixture.
  if (process.exitCode) console.error(`Disposable test evidence: ${cluster}`);
  else await rm(cluster, { recursive: true, force: true });
}
