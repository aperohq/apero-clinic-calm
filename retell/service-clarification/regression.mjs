// Existing offline v19 safety fixtures against the complete new configuration.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
const root = new URL("./", import.meta.url),
  legacy = new URL("../remediation-v19/", root),
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "apero-service-regression-"));
for (const name of ["common.mjs", "runtime.mjs", "test.mjs"])
  fs.copyFileSync(new URL(name, legacy), path.join(dir, name));
// Keep the old fixture filename, but use the actual published input version.
fs.copyFileSync(new URL("baseline-v21.json", root), path.join(dir, "baseline-v17.json"));
fs.copyFileSync(new URL("candidate.json", root), path.join(dir, "candidate.json"));
fs.writeFileSync(
  path.join(dir, "build.mjs"),
  `export {build,allEdges} from ${JSON.stringify(new URL("build.mjs", root).href)};`,
);
const result = spawnSync(process.execPath, [path.join(dir, "test.mjs")], { stdio: "inherit" });
process.exitCode = result.status ?? 1;
