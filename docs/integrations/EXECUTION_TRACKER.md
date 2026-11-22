# Integration execution tracker

Updated 2026-11-22. Implementation is local until the release is authorized. Production/real-account acceptance remains explicitly separate.

| #   | Requirement                      | Implementation                   | Validation / remaining work                                                                                                                                           |
| --- | -------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Secure versioned API             | Implemented                      | Key-derived clinic, bounded routes, generic errors; deployed acceptance pending                                                                                       |
| 2   | Clinic keys / credentials        | Implemented                      | Hash-only keys, owner-only creation, scoped permissions, 90-day expiry, rotation/revocation, rate limiting; encrypted Google credentials                              |
| 3   | Google OAuth / token management  | Implemented with mocks           | PKCE, browser+actor-bound single-use state, AES-GCM context, serialized refresh/CAS; real credentials/consent pending                                                 |
| 4   | Connection / calendar selection  | Implemented                      | Writable calendars, clinic practitioner validation, immutable selection, retry/disconnect; real clinic selection pending                                              |
| 5   | Booking / availability sync      | Implemented                      | Atomic outbox, stable provider IDs, paginated snapshots, all-day/DST, stale/horizon gate; real provider acceptance pending                                            |
| 6   | Cancellation / rescheduling      | Implemented                      | Existing guards retained; outgoing update/delete and replay-safe behavior tested                                                                                      |
| 7   | Webhooks / idempotency / retries | Implemented                      | Channel token/resource/expiry/sequence, periodic recovery, fenced leases, generations, bounded drain, retries/dead letters/manual recovery                            |
| 8   | Conflicts / double booking       | Implemented locally              | Existing GiST exclusion + connection lock; native request and snapshot races pass; unavoidable Google-side race documented                                            |
| 9   | Integrations dashboard           | Implemented, default off         | Owner/key/selection/error/clinic-switch tests and Chromium 320/375/768/1440 checks; real portal acceptance pending                                                    |
| 10  | Clinic-system adapters           | Reusable infrastructure complete | Typed provider contract and Google adapter; a named clinic software provider/account remains unidentified                                                             |
| 11  | RLS / audit / monitoring         | Implemented                      | Internal tables and RPC restrictions, schema hardening, lifecycle audit, safe logs, retention/hold rules, offboarding revocation; production alert activation pending |
| 12  | Automated tests / regression     | Implemented                      | Provider/HTTP tests, 17 DB scenarios, 4 native races, UI checks, original regressions; final hosted CI pending                                                        |
| 13  | GitHub / CI / deploy preparation | Prepared                         | Isolated branch from protected current main; all five checks retained, integration checks added; publish/CI progress in EXECUTION_STATE.md                            |
| 14  | Docs / final acceptance          | Local package complete           | API/OpenAPI, prompt, runbook, rollback/schedule templates, acceptance/evidence; production and real accounts pending authorization                                    |

The Account lifecycle fixture's new Supabase import boundary was corrected and rerun; no production control or required check was disabled. Exact run results, branch and commits are in EXECUTION_STATE.md. External actions are consolidated in APPROVALS_REQUIRED.md. Money spent: $0.
