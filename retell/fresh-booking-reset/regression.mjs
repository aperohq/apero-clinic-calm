// Run unchanged v19 behavioral/static tests against the new compiled config.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
const root = new URL("./", import.meta.url),
  legacy = new URL("../remediation-v19/", root),
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "apero-reset-regression-"));
for (const name of ["common.mjs", "runtime.mjs", "baseline-v17.json", "test.mjs"])
  fs.copyFileSync(new URL(name, legacy), path.join(dir, name));
fs.copyFileSync(new URL("candidate.json", root), path.join(dir, "candidate.json"));
fs.copyFileSync(new URL("build.mjs", legacy), path.join(dir, "legacy-build.mjs"));
fs.writeFileSync(
  path.join(dir, "build.mjs"),
  `import {build as legacy,allEdges} from './legacy-build.mjs';import {build as fresh} from ${JSON.stringify(new URL("build.mjs", root).href)};export {allEdges};export const build=x=>fresh(legacy(x));`,
);
const result = spawnSync(process.execPath, [path.join(dir, "test.mjs")], { stdio: "inherit" });
process.exitCode = result.status ?? 1;
