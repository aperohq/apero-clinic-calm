// Deterministic scope runner: synthetic databases and mocked UI only.
// Deliberately does not invoke the repository-wide release/voice/provider suites.
import { spawnSync } from "node:child_process";
const commands = [
  [
    "--max-old-space-size=512",
    "--test",
    "--test-concurrency=1",
    "tests/onboarding-provisioning.test.mjs",
    "tests/onboarding-access.test.mjs",
    "tests/onboarding-integration-boundaries.test.mjs",
    "tests/onboarding-lifecycle.test.mjs",
    "tests/member-reactivation.test.mjs",
    "tests/onboarding-cli.test.mjs",
  ],
  ["tests/clinic-readiness-ui.test.mjs"],
  ["tests/run-clinic-permission-tests.mjs", "--team"],
];
for (const args of commands) {
  const result = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
