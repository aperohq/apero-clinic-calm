# Account lifecycle acceptance — local evidence

Status: IMPLEMENTED / NOT DEPLOYED. Synthetic tests only; no production account,
invitation, email, credential, integration or ownership changes were made.

The existing `profiles` membership model remains authoritative. Existing team
invitations, Owner-only role changes, revocation, protected ownership and
history-preserving account offboarding are reused.

Added migrations:

- `20261124110000_clinic_member_reactivation.sql`: explicit Owner restoration of
  verified same-clinic Manager/Staff accounts, preserving role and historical
  attribution. Pending/unconfirmed accounts, owners, self and foreign identities
  cannot be restored. Repeated restoration does not duplicate audit entries.
  Membership role/revocation changes generate an append-only audit record; only
  the current clinic Owner and trusted service credentials can read the audit.
  Audit clinic/profile identifiers survive authorized erasure without blocking
  clinic deletion through foreign keys.
- `20261124111000_suspended_team_management.sql`: account-management RPCs lock
  and recheck the Owner and reject suspended/closed clinics. This closes the
  direct-profile lookup bypass of the new lifecycle-aware tenant helpers.
  Operator and Owner invitation reservation paths receive the same check.
  Previous implementations are retained behind wrappers with execute revoked
  from public/browser/service roles.

The existing account-access panel now offers a confirmation before restoration,
verifies the saved result, retains a useful error/retry state and displays a
read-only Owner MFA readiness check from Supabase factors and session assurance.
An enrolled factor alone does not claim that the session is MFA verified or that
account recovery is ready.

VERIFIED locally:

- `node --max-old-space-size=384 tests/member-reactivation.test.mjs`: real
  disposable PGlite PostgreSQL account-only schema; Owner/Manager/Staff and
  cross-clinic restoration denial; pending-account denial; direct UPDATE denial;
  retry safety; audit isolation; effective revocation under retained claims;
  suspended-clinic role/revoke/restore and trusted invitation denial.
- `node tests/run-clinic-permission-tests.mjs --team`: 19 tests passed using the
  real SDK and React with local HTTP mocks. Tests cover existing invite/resend,
  errors, role changes and revoke behavior plus restoration confirmation,
  failure/retry and Owner MFA readiness. No outgoing messages are sent.

EXTERNAL DEPENDENCY / UNKNOWN: production Auth password/recovery policy, actual
MFA enrollment and recovery rehearsal, session policy, invitation expiry settings
and real clinic UAT. MFA enrollment and provider configuration are not changed by
these readiness checks. Ownership transfer remains blocked from browser roles;
any real ownership reassignment needs a separately reviewed authorized operation.

Deployment requires review and explicit approval. Apply the onboarding and
activation migrations before the account hardening migrations in timestamp order.
Rollback should disable restoration UI and revoke its RPC execute privilege while
preserving the audit table. Do not undo clinic suspension checks or erase audit
records to roll back a UI issue. Retain the wrapper security boundary when
repairing any future version of the underlying account functions.
