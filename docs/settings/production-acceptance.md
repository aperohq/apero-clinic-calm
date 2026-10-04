# Settings production acceptance — 2026-10-04

Project: `svoybvzvmygszklcmudh`.

## Installed migration

The operator applied `20261003200000_clinic_settings.sql` manually. Release work
verified it without rerunning any migration or deploying an Edge Function.
All twelve columns, the validation trigger and the save RPC are present.
Installed function bodies match the accepted local SQL exactly after normalizing
line endings. Both functions use SECURITY INVOKER and fixed search paths;
anonymous execution is denied and clinic RLS remains enabled.

## Production API acceptance

Twenty-eight checks passed using actual signed-in disposable Owner, Manager,
Staff and foreign-clinic Owner sessions. Real clinic edits were restored after
each case. Checks covered canonical load, profile/contact/location edits,
optional clearing, valid websites including IPv6, malformed websites through
RPC and direct UPDATE, valid/invalid timezone, public hours, unchanged booking
availability, receptionist names, partial-update preservation, role restrictions,
foreign-clinic access/write rejection, Auth health and Team directory health.

Full before/after comparisons confirmed the original clinic row, appointments,
conversations, practitioners, availability, time off, clients, voice integrations
and memberships were preserved. All eleven appointment records retained their
stored timestamps. Cleanup removed every disposable profile, Auth identity and
foreign clinic; production returned to one clinic, two profiles, two Auth users,
eleven appointments and twenty-nine calls. No Retell call or sync occurred.

An initial harness comparison treated JSON object key order as significant.
The harness was corrected to compare canonical structures; its temporary hours
were restored and accounts removed before the final successful acceptance run.
This required no application or database-code change.

## Local validation

All 513 test results passed, including 97 Settings results, Auth, permissions,
clinic isolation, Team/invitations, provisioning, appointments/conflicts,
timezone, voice routing/Edge isolation and request security. Frontend TypeScript,
existing invitation-backend TypeScript, production build, targeted lint and
`git diff --check` passed. Two pre-existing Auth Fast Refresh lint warnings remain.
Checks used accepted HEAD plus only Settings changes, excluding unrelated edits.

## Published frontend

Browser automation is unavailable. Published Lovable assets were inspected:
the Team release is present, but `update_clinic_settings`, receptionist Settings
fields and the Settings page implementation are absent. A reserved route name in
the permissions map does not establish that the Settings UI is published.
The 32 local Settings UI results verify the accepted UI against the real SDK;
production API acceptance does not substitute for published-frontend acceptance.

**LOVABLE MANUAL PUBLISH REQUIRED** after the Settings commit reaches GitHub.
Settings is not launch-ready until publishing and final deployed UI acceptance.
Secrets, session tokens and clinic/patient values are omitted from this report.
