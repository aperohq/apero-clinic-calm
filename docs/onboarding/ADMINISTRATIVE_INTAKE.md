# Administrative clinic intake

Local proposal, **IMPLEMENTED / NOT DEPLOYED**. Keep existing Tally forms. A trusted operator maps an approved export into the JSON below and prepares an offline SQL dry run. No public provisioning endpoint, browser service credential, provider request, or email is introduced.

```json
{
  "clinic": {
    "name": "Synthetic clinic",
    "localized_name": "عيادة اختبار",
    "clinic_type": "dental",
    "phone": "+96555550123",
    "email": "clinic@example.test",
    "address": "Synthetic address",
    "country": "KW",
    "timezone": "Asia/Kuwait",
    "receptionist_name": "نور",
    "opening_hours": {
      "days": [
        { "day": 0, "periods": [{ "start": "09:00", "end": "17:00" }] },
        { "day": 1, "periods": [{ "start": "09:00", "end": "17:00" }] },
        { "day": 2, "periods": [{ "start": "09:00", "end": "17:00" }] },
        { "day": 3, "periods": [{ "start": "09:00", "end": "17:00" }] },
        { "day": 4, "periods": [{ "start": "09:00", "end": "17:00" }] },
        { "day": 5, "periods": [] },
        { "day": 6, "periods": [] }
      ]
    }
  },
  "owner_auth_id": "00000000-0000-4000-8000-000000000910",
  "owner_name": "Synthetic Owner",
  "services": [{ "name": "Consultation", "duration_minutes": 30 }],
  "practitioners": [
    {
      "name": "Synthetic practitioner",
      "specialty": "Dental",
      "services": ["Consultation"],
      "availability": [{ "day": 0, "start": "09:00", "end": "17:00" }]
    }
  ],
  "closures": ["2026-12-25"],
  "faqs": [{ "question": "Where?", "answer": "Approved clinic information" }],
  "synthetic": true
}
```

Use an existing verified Auth user with no membership. This workflow does not create accounts or deliver credentials. Existing-user association preserves the established one-clinic-per-identity model. Account creation/recovery and owner MFA deployment checks remain separate launch gates.

`city` and `receptionist_localized_name` are optional clinic fields. All other clinic fields shown are required, including the patient-facing Arabic name. Strings stay Unicode. Phones must use E.164; timezone must be an accepted IANA zone. Hours reuse the existing seven-day schema. Public opening hours support up to four intervals per day. Each practitioner must provide explicit approved `availability` entries (`day`, `start`, `end`), one interval per weekday, entirely inside an open clinic period. Clinic hours never silently become practitioner schedules. The existing practitioner schema cannot represent two shifts for one practitioner on one weekday; that case needs a separate scheduling design and remains a known limitation. Holidays become clinic-local full-day staff time off, including timezone conversion. Explicit practitioner availability remains a clinical sign-off item: do not assume clinic public hours imply a practitioner's actual availability without approval.

Services and durations are the **reviewed intake catalog**, preserved in `clinic_onboarding.payload`; practitioner eligibility uses existing `staff.services`. This change does not alter appointment duration calculation or any external integration. Readiness detects drift from the reviewed catalog. FAQs are stored for administrative review, not published to excluded voice infrastructure.

Prepare a private artifact outside the repository:

```sh
node scripts/onboarding/prepare-intake.mjs /tmp/clinic-intake.json tally-stable-submission-id /tmp/clinic-intake-dry-run.sql
```

The file is created exclusively with mode 0600. It contains contact information: do not commit or attach real intake artifacts. Review and execute only against a disposable synthetic database initially. Database constraints and validators run inside a transaction that ends with `rollback`. The generator performs no database/network operation. A trusted administrator can separately approve changing the reviewed transaction to `commit`; production execution requires explicit approval. Do not run historical seed scripts.

Retry an identical payload with the same stable submission key. It returns the original clinic without additional membership, schedule or audit inserts. A changed payload with the same key fails. Failed transactions leave no partial rows and may be retried with corrected input. A different key cannot claim the same confirmed owner or normalized contact phone. Shared clinic phone numbers require manual duplicate review; the operator must not bypass it by fabricating a contact.

Incomplete submissions remain in Tally/the private intake artifact and cannot provision. Correct the actionable validation failure, then retry. No account creation can be orphaned because all existing-user association and clinic configuration writes occur in one transaction.

## Readiness and lifecycle

`clinic_activation_readiness()` is an owner-scoped read with no client clinic argument required. Trusted service operations may pass a specific clinic UUID. Missing intake, invalid fields, missing scheduled service practitioners, catalog drift, pending accounts, synthetic classification and unreviewed existing clinical records block readiness. Existing clinic data before activation must receive an explicit cleanup assessment (`review_data`, with a reason, records a trusted assessment and performs no deletion): this workflow never deletes patient records or automatically removes demo data.

Readiness stages are explicit. Complete imported configuration first reports `configuration_complete`. A trusted `review_technical` decision records the consent revision and a fingerprint of the current clinic, staff, schedules, closures and memberships, advancing to `technically_activation_ready`. `await_external` records that external acceptance is being collected and advances to `awaiting_external_dependencies`. Changes to the fingerprint require a fresh technical review. None of these decisions activates a clinic. After activation, ordinary real patient/appointment creation does not undo the activation decision; configuration drift is still reported separately as failures.

`decide_clinic_lifecycle` requires trusted server credentials and a review reason. Activation additionally requires complete configuration, a matching fresh technical-review fingerprint and consent revision and an explicit external-release approval flag. Those attestations represent a human release decision, not automated provider verification. Retell/live telephone, integration/MFA deployment evidence and clinic UAT always remain separately displayed external dependencies. Never call activation for a paying clinic without explicit authorization.

Suspension/closure makes existing JWTs lose portal authorization through the existing membership helpers. Reactivation restores configuration access and requires a new activation decision. Closure is terminal here and does not delete records, lift legal holds, or invoke retention/provider cleanup. Existing retention/offboarding infrastructure remains authoritative for erasure.

Migration rollback: revert the UI first; do not drop intake/audit records. Removing lifecycle-aware membership helpers could restore suspended access, so restore authorization only after reviewing affected clinics. Apply production migrations in timestamp order after backup, migration and release approval. New audit rows intentionally survive clinic deletion and contain UUIDs/event/reason only; do not place patient or credential information in review reasons.

## Field mapping and local acceptance

| Intake field                                                                      | Existing persistence                                                                                    |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `clinic` approved English/Arabic names, contact, location, timezone, public hours | Whitelisted `clinics` columns                                                                           |
| `owner_auth_id`, `owner_name`                                                     | Verified `auth.users` identity and existing `profiles` owner membership                                 |
| `services` names/durations                                                        | Reviewed `clinic_onboarding.payload.services`; existing scheduler compatibility is a release dependency |
| `practitioners` identity/specialty/eligibility                                    | Existing `staff` and `staff.services`                                                                   |
| Explicit practitioner `availability`                                              | Existing `staff_availability`, one interval per weekday                                                 |
| `closures` local dates                                                            | Existing `staff_time_off` for each practitioner, timezone-aware full days                               |
| `faqs` approved clinic information                                                | Private reviewed intake payload; not published to voice/provider infrastructure                         |
| Stable submission key and `synthetic` classification                              | Restricted onboarding record and lifecycle/audit contract                                               |

Readiness also checks core RLS/anonymous grants, protected membership mutation and restricted administrative RPC execution. Disabled database enforcement blocks technical review and activation. Deployed isolation/production evidence remains a separate release gate.

Run the portable synthetic contract/UI suite with `node scripts/onboarding/test-local.mjs`. With native PostgreSQL/cron tools available, run `APERO_TEST_PG_BIN=/path/to/postgresql/bin node --test tests/onboarding-native.test.mjs`; the helper creates a fresh Unix-socket-only database and never accepts a production URL. Optional browser acceptance uses separately installed Playwright 1.65.1 via `APERO_PLAYWRIGHT_MODULE`, `PLAYWRIGHT_BROWSERS_PATH` and `APERO_BROWSER_EVIDENCE_DIR`: run `node tests/onboarding-responsive.test.mjs`. It serves a temporary localhost-only harness and blocks external requests. The prepared CI workflow provides equivalent free tooling on disposable runners but has not been published or run remotely.

## Register an existing clinic without recreating it

Pass an existing clinic UUID as the optional fourth generator argument:

```sh
node scripts/onboarding/prepare-intake.mjs /tmp/existing-intake.json stable-existing-submission /tmp/existing-dry-run.sql 00000000-0000-4000-8000-000000000100
```

The resulting private rollback transaction calls `register_existing_clinic_intake`. Trusted registration verifies the saved clinic fields, confirmed usable owner, complete active practitioner roster, service eligibility, explicit schedules and closure coverage against the supplied intake. Conflicts fail with an actionable error. It does not create, move or replace clinic, membership, practitioner or schedule records. Identical retries return the same clinic and do not duplicate the registration audit. Existing offboarding prevents registration and account/API admission, even if an old profile remains active.

**Operational rollout gate:** registering an existing clinic adds it to the new activation contract. Existing API keys become activation-gated until a separate authorized review/activation decision; registration does not automatically activate a real clinic. Rehearse in a disposable environment, plan the rollout and obtain explicit production approval before committing a real registration. No automatic legacy backfill is performed.

For integrated local acceptance, install the same isolated native/browser tools, then run `node tests/onboarding-e2e.test.mjs` with `APERO_TEST_PG_BIN`, `APERO_PLAYWRIGHT_MODULE`, `PLAYWRIGHT_BROWSERS_PATH` and optional `APERO_E2E_EVIDENCE_DIR`. This tests real panels, the real Supabase SDK and actual native SQL/RLS through a localhost-only test adapter. Auth issuance/transport are synthetic; it does not certify hosted GoTrue/JWT policy or deployed whole routes.
