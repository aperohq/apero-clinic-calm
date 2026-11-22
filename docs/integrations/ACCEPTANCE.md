# Integration acceptance record

2026-11-22. All records, accounts, tokens and screenshots used for local testing are synthetic. No Google account was connected and no live appointment or Retell call was changed.

| Requirement                          | Local evidence                                                                                                                                      | Production / external acceptance                                                                                     |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| API / clinic key security            | Provider/HTTP tests, real PostgreSQL key hashing/scopes/rate/expiry and tenant tests                                                                | Repeat against authorized deployed target                                                                            |
| Key creation / rotation / revocation | Owner-only DB RPCs, one-time key UI, immediate invalidation, staff/revoked-owner denial                                                             | Clinic owner saves a real key in a secret manager                                                                    |
| Google OAuth / token lifecycle       | PKCE, browser+actor-bound single-use state, encrypted context, refresh lease/CAS tests                                                              | Configure Google project, consent/verification, authorize real test account, validate refresh and account revocation |
| Connection / calendar selection      | Writable calendar pagination, clinic/practitioner validation, immutable selection, disconnect and UI tests                                          | Owner explicitly selects actual clinic calendar                                                                      |
| Book / reschedule / cancel           | Stable outbound IDs, create races, cancellation retries, source guards and atomic outbox                                                            | Observe all three changes in a real test calendar                                                                    |
| Calendar availability                | Paginated bounded snapshots, recurrence flags, DST/all-day conversion, freshness/horizon denial, own-event exclusion                                | Confirm actual recurring/all-day events and timezone settings                                                        |
| Idempotency / double booking         | Native duplicate-request and competing-booking races, original exclusion regression                                                                 | Authorized deployed concurrency smoke test                                                                           |
| Calendar import races                | Both native booking-vs-import orders tested; stale snapshot generation rejected                                                                     | Observe notification/poll lag under clinic workload                                                                  |
| Failure recovery                     | Quota/retry classification, capped jitter, expired/stale leases, generation preservation, dead-letter/manual retry, deleted-event identity revision | Real revoked/expired token, webhook renewal, provider timeout and quota drills                                       |
| Dashboard / supported devices        | Functional role/key/selection/error/clinic-switch tests; Chromium at 320,375,768,1440 px, no overflow/errors                                        | Actual authenticated portal and clinic device acceptance                                                             |
| Security / audit / retention         | Internal table/worker RPC denial, clinic isolation, audit lifecycle, approved-offboarding revocation, existing legal-hold-aware cleanup             | Review secret installation, operational access and alerts                                                            |
| Retell compatibility                 | Existing shared booking/exclusion/race and synthetic release suites                                                                                 | Approved live Retell acceptance only if explicitly authorized                                                        |
| Clinic-system adapters               | Provider-neutral typed contract; Google concrete implementation                                                                                     | Provider selection/API contract and account authorization needed for a named clinic software connector               |
| GitHub / CI / deployment             | Isolated additive branch; five protected checks retained; release and rollback templates                                                            | Hosted CI results at candidate SHA, merge/publication decision, explicit production release authorization            |

## Evidence

- `tests/integrations.test.mjs`: provider, crypto, OAuth, HTTP boundary, token refresh, worker and webhook behavior with network mocks.
- `tests/integration-database.test.mjs`: real PostgreSQL/WASM with two clinics; not a query mock.
- `tests/integration-native.test.mjs`: native PostgreSQL multi-session idempotency, competing booking and both snapshot/booking lock orders.
- `tests/integrations-ui.test.mjs`: rendered React controls, role isolation, errors and stale clinic-response safety.
- Existing `test:appointment-concurrency`: unchanged Retell/portal race coverage.
- `test:native-migrations`: full fresh/upgrade/restricted-owner chain, real pg_cron and encrypted synthetic dump/restore in both extension-schema layouts.
- `evidence/results.json`, `evidence/integrations-320.png`, `evidence/integrations-1440.png`: synthetic Chromium layout checks with production CSS. These show the panel in isolation; they are not real portal/Google acceptance.
- Hosted CI and exact commit status are recorded in `EXECUTION_STATE.md`; a local pass never substitutes for a required hosted check.

The Account lifecycle fixture initially failed because the newly imported panel introduced an unmocked Supabase client module. Its provider boundary is now mocked in that fixture; dedicated integration tests cover the panel separately. The failed suite was rerun. No check or production security control was weakened to fix the test.

## Explicit limits

Google and Apero cannot perform a distributed transaction. The local exclusion constraint and connection locking prevent local double bookings; provider-side changes after the last read are detected and surfaced, rather than promised impossible. Apero remains authoritative for patient appointments; external edits contribute busy time and trigger reconciliation, not silent patient-record mutations. Real Google/clinic-provider acceptance and production release cannot be completed using mocks.

The documentation-only CI rerun also exposed a local Supabase host-port collision on 54324. The bootstrap harness now assigns distinct available host ports to each temporary stack; it retains all services and every existing managed database/cron assertion. This is fixture isolation, not a skipped or weakened check.
