import assert from "node:assert/strict";
import { test } from "node:test";
import { isolateSupabasePorts } from "../scripts/helpers/supabase-ports.mjs";

test("temporary Supabase stacks keep every service and use distinct host ports", async () => {
  const config = `project_id = "apero-supabase-ci-test"
[api]
port = 54321
[db]
port = 54322
shadow_port = 54320
[studio]
port = 54323
[inbucket]
port = 54324 # health checks still run
[edge_runtime]
inspector_port = 8083
[auth]
site_url = "http://127.0.0.1:3000"
jwt_expiry = 3600
`;
  let next = 31000;
  const isolated = await isolateSupabasePorts(config, async () => ++next);
  assert.equal(isolated.ports.length, 6);
  assert.equal(new Set(isolated.ports).size, 6);
  assert.match(isolated.config, /\[inbucket\]\nport = 31005 # health checks still run/);
  assert.match(isolated.config, /site_url = "http:\/\/127.0.0.1:3000"/);
  assert.match(isolated.config, /jwt_expiry = 3600/);
  assert.match(isolated.config, /project_id = "apero-supabase-ci-test"/);
  const other = await isolateSupabasePorts(config, async () => ++next);
  assert.equal(
    other.ports.some((port) => isolated.ports.includes(port)),
    false,
  );
});
test("duplicate reservations retry and exhausted/invalid allocations fail safely", async () => {
  const values = [31001, 31001, 31002];
  assert.deepEqual(
    (await isolateSupabasePorts("port = 1\nshadow_port = 2", async () => values.shift())).ports,
    [31001, 31002],
  );
  await assert.rejects(
    () => isolateSupabasePorts("port = 1", async () => 80),
    /Invalid local test port/,
  );
  await assert.rejects(
    () => isolateSupabasePorts("port = 1\nshadow_port = 2", async () => 31001),
    /distinct local test ports/,
  );
  await assert.rejects(
    () => isolateSupabasePorts("project_id = 'x'", async () => 31001),
    /no numeric host ports/,
  );
});
