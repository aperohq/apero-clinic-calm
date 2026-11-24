# Integration execution tracker

Updated 2026-11-24 UTC. Approved production scope: the private synthetic calendar for Dr. Ahmed Qandil. Production and actual Google acceptance are complete for this scope; no general clinic rollout is implied.

| #   | Requirement                    | Status and evidence                                                                                                                                                                 |
| --- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Secure integration API         | Live API v3; bounded routes, clinic-bound permissions, security and isolation checks pass.                                                                                          |
| 2   | Clinic keys and credentials    | Hash-only creation/rotation/revocation and permissions tested; both temporary live acceptance keys revoked; OAuth ciphertext preserved.                                             |
| 3   | Google OAuth/token management  | Real owner consent completed; account-bound reuse/reconnection regression passed; actual refresh succeeded and ongoing scheduled sync stayed healthy overnight.                     |
| 4   | Connection/calendar selection  | Exactly one active Connected private-calendar mapping for Dr. Ahmed; repeat selection/Connect guarded and idempotent; disconnected historical row retained.                         |
| 5   | Appointment/availability sync  | Real book/replay and Google event identity verified; initial and scheduled busy/free snapshots pass; current freshness and horizon safeguards retained.                             |
| 6   | Cancellation/rescheduling      | Real same-event move and delete/repeated cancel passed; final event cleanup verified.                                                                                               |
| 7   | Webhooks/idempotency/retries   | Real webhook 204 delivery; startup sync/1 correction live; scoped worker leases, retry/dead-letter behavior and actual once/minute scheduling verified.                             |
| 8   | Conflicts/double booking       | Native races and live competing-slot/external-busy409 pass; duplicate-event checks pass; both GiST exclusions and stale booking gate retained.                                      |
| 9   | Integrations dashboard         | Published by owner; actual source/browser checks and owner Connected confirmation; status, account/calendar/practitioner, history and recovery controls tested on supported widths. |
| 10  | Clinic-system adapters         | Reusable contract and Google adapter complete. A future named clinic-software connector needs a named provider/account, outside this synthetic Google release.                      |
| 11  | Security/RLS/audit/monitoring  | 133 security tests, tenant isolation, API/Vault boundaries and recovery ACL checks pass; safe errors/status, history and monitoring retained. No Retell configuration change.       |
| 12  | Tests/regressions              | Provider, DB, native race, UI, existing booking/Retell checks pass; all five protected checks passed for deployed PR8/9 and their merges. Final backup regression:10 tests pass.    |
| 13  | GitHub/CI/deployment           | PR8/9 protected normal merges; additive migrations reviewed/restored and applied; API/worker3/webhook2 live. No branch protection/history bypass.                                   |
| 14  | Documentation/final acceptance | Live Google acceptance, owner publication, automatic sync, fresh encrypted restore and cleanup recorded; final state and authorization boundaries persisted.                        |

The root causes, code references, deployment ledger, test scope and rollback are in EXECUTION_STATE.md and LIVE_CALENDAR_ACCEPTANCE.md. Sanitized evidence is in evidence/calendar-live-release.json. Private backup catalogs, tokens and configuration stay outside git.

Remaining action for the owner: **none for this connection**. Money spent: **$0**.
