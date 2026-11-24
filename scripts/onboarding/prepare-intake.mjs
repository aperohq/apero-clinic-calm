#!/usr/bin/env node
// Offline only: emits a transaction for trusted administrator review. No network,
// credentials, Auth invitations, provider calls or database connection.
import { readFile, writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
if (![3, 4].includes(args.length)) {
  console.error(
    "Usage: node scripts/onboarding/prepare-intake.mjs intake.json stable-submission-key output.sql [existing-clinic-uuid]",
  );
  process.exit(2);
}
const [source, key, destination, existingClinic] = args;
if (
  args.length === 4 &&
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(existingClinic ?? "")
)
  throw new Error("Existing clinic must be a UUID");
if (key.length < 8 || key.length > 200)
  throw new Error("Submission key must contain 8–200 characters");
const raw = await readFile(source, "utf8");
if (Buffer.byteLength(raw) > 262144) throw new Error("Intake exceeds 256 KiB");
const payload = JSON.parse(raw);
if (!payload || Array.isArray(payload) || typeof payload !== "object")
  throw new Error("Expected intake object");
const literal = (value) => "'" + value.replaceAll("'", "''") + "'";
const sql = `-- PRIVATE clinic intake. Review against docs/onboarding/ADMINISTRATIVE_INTAKE.md.
-- Requires trusted database administrator; default dry run always rolls back.
-- Do not execute against production without explicit migration/data-write approval.
begin;
set local standard_conforming_strings = on;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
${
  existingClinic
    ? `-- Existing API keys become activation-gated; review rollout before committing.
select public.register_existing_clinic_intake(${literal(existingClinic)}::uuid, ${literal(key)}, ${literal(JSON.stringify(payload))}::jsonb, 'Reviewed administrative intake registration');`
    : `select public.provision_clinic(${literal(key)}, ${literal(JSON.stringify(payload))}::jsonb);`
}
rollback;
`;
await writeFile(destination, sql, { encoding: "utf8", mode: 0o600, flag: "wx" });
console.log(
  "Private dry-run SQL prepared. Database validation occurs inside the rollback transaction.",
);
