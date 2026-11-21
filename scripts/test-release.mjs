// Explicit local/mock allowlist. Never discover or execute Retell simulation,
// deployment, provider-worker or backup commands from package scripts.
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const suites = [
  "test:stabilization",
  "test:auth",
  "test:recordings",
  "test:analytics",
  "test:appointment-migration",
  "test:appointment-conflicts",
  "test:appointments",
  "test:security",
  "test:clinic-users",
  "test:clinic-user-cli",
  "test:permissions",
  "test:permissions:ui",
  "test:team",
  "test:settings",
  "test:navigation",
  "test:invite-setup",
  "test:booking-fallback",
  "test:calendar-unavailable",
  "test:unknown-answer",
  "test:human-escalation",
  "test:call-transfer",
  "test:system-downtime",
  "test:retention",
  "test:demo",
  "test:monitoring",
];
const dir = process.env.APERO_TEST_RESULTS_DIR ?? join(tmpdir(), "apero-release-results");
mkdirSync(dir, { recursive: true });
const results = [];
async function run(command, args, timeout) {
  return await new Promise((resolve) => {
    let stdout = "",
      stderr = "",
      error;
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: process.platform === "win32",
      detached: process.platform !== "win32",
    });
    const timer = setTimeout(() => {
      error = "Test timeout";
      if (process.platform === "win32") child.kill("SIGTERM");
      else
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {}
    }, timeout);

    child.on("error", (e) => {
      error = e.message;
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr, error });
    });
  });
}
for (const suite of suites) {
  const r = await run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", suite], 180000);

  const status = r.status === 0 && !r.error ? "PASS" : "FAIL";
  results.push({ suite, status, exit: r.status, error: r.error });
  console.log(status, suite);
}
const python = await run(
  process.platform === "win32" ? "python" : "python3",
  ["-m", "unittest", "discover", "-s", "scripts/operations", "-p", "test_*.py"],
  60000,
);
results.push({
  suite: "python-operations",
  status: python.status === 0 && !python.error ? "PASS" : "FAIL",
});
const utf8 = await run(
  process.platform === "win32" ? "python" : "python3",
  ["-m", "unittest", "discover", "-s", "tests", "-p", "test_utf8_io.py"],
  60000,
);
results.push({ suite: "python-utf8", status: utf8.status === 0 && !utf8.error ? "PASS" : "FAIL" });
writeFileSync(join(dir, "summary.json"), JSON.stringify(results, null, 2));
console.log("Local evidence:", dir);
process.exitCode = results.some((r) => r.status === "FAIL") ? 1 : 0;
