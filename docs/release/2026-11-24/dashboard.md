# Dashboard acceptance — T-031, T-063, T-064 and T-073

Baseline: GitHub main `cd858f56cf87269e0bc70e25fceaca0dd8602c98`. This report distinguishes current isolated component/route acceptance, current public production checks and reused authenticated production evidence. No production membership, credential or factor fields were changed; normal Auth session/login metadata is recorded separately. Credentials were entered only in the separately documented authorized hosted synthetic Owner/Staff follow-up.

## Current isolated browser execution

Reproducible harness: `scripts/acceptance/dashboard-browser.mjs`. It compiles the actual page components, `RouteShell`, `AppLayout`, data hooks, settings/readiness/integration panels, and production CSS. Actual TanStack routing and query caching execute in Chromium. Only Auth and database transport boundaries return synthetic responses; external requests are blocked. The custom route tree selects the approved file routes' actual components without importing excluded demo routes. This does not certify SSR, generated file-route wiring, hosted Auth token issuance, backend authorization, or external integrations.

`evidence/browser-results.json` is the terminal result: **155/155 PASS** (120 route/role/viewport assertions + 35 control/data-state assertions), zero page errors, zero external requests, Chromium `159.0.8154.6`. `evidence/browser-source-manifest.json` records SHA-256 source/harness identities. Each `route:<role>:<width>:<path>` scenario verifies navigation availability, expected role denial, and document horizontal geometry. The matrix covers:

| Routes                                                                                                                                    | Roles                 | Widths              | Assertions |
| ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ------------------- | ---------- |
| `/home`, `/calendar`, `/clients`, `/staff`, `/conversations`, `/requests`, `/analytics`, `/account`, `/account/team`, `/account/settings` | Owner, Manager, Staff | 1440, 768, 390, 320 | 120        |

Integrations and activation readiness are panels on `/account`, not standalone routes. Calls and recording interfaces are reached through Conversations. Staff is denied Staff management, Requests, Analytics, Team and Settings. Manager is denied Settings and sees the corresponding restricted account controls. Frontend denial is presentation evidence only; backend authorization is covered separately by account/security execution.

The additional controls exercise:

- Mobile menu opening and navigation/closure.
- Auth loading, account-load error, unlinked account, anonymous redirect and synthetic login navigation.
- Appointment dialog bounds at 390px and Escape closure.
- Analytics date-range selection, sanitized error and retry.
- Settings edit/discard confirmation and restoration of saved values.
- Populated synthetic client, practitioner and appointment rendering.
- Explicit incomplete-onboarding readiness rendering.
- Integration status refresh failure and recording-load denial/error display.
- Home, Calendar, Clients, Staff and Conversations data loading, sanitized failure and successful retry.

The calendar deliberately scrolls internally on small screens while the document remains within the viewport. Screenshots `evidence/browser-*.png` contain only synthetic data. Account/Settings mobile screenshots were visually inspected; no redesign or application fix was justified by observed behavior.

Harness corrections: the first version incorrectly expected desktop navigation to remain visible on mobile; it was corrected to assert the mobile menu button. A subsequent error-injection timeout came from clearing query observers without refetching. `resetQueries()` fixed the fixture driver. The original timeout is retained as `evidence/browser-harness-timeout.json`; its partial output is not a successful suite result and does not represent a product defect. The focused driver rerun passed 19 controls before the final valid-readiness/loading coverage was added; `evidence/browser-control-focus.json` is supporting evidence only and must not be added to final counts.

## Current bounded production execution

`evidence/browser-production-public.json`: **30/30 PASS**, zero page errors, Chromium `159.0.8154.6`. Ten public/protected paths at 1440/768/390 render Login or redirect to Login in fresh contexts. Login has no document horizontal overflow. `scripts/acceptance/public-dashboard-browser.mjs` reproduces this check. Only GET dashboard/static/font resources are allowed. All 39 attempted telemetry POSTs were blocked. No Supabase account/data/API request or credential submission was permitted. These checks establish public login/route gating only.

## Reused authenticated production evidence

The pre-existing report `/home/nour/apero-onboarding-release-20261124/production-acceptance-20261124/FINAL_ACCEPTANCE_REPORT.md` records **50 primary + 9 follow-up passing assertions** on November 24. It used three already admitted synthetic Owner/Staff identities across two clinics through actual hosted Auth. Evidence includes fifteen real-JWT cross-clinic read denials, live Team/readiness status, dialog opening/cancel, and Login/Account/Team/Calendar at 375/768/1440. No production business mutation or real invitation occurred. Source baseline is the same merged PR #11; publication attribution is founder-attested and supported by live lazy-chunk feature hashes, not an independently exposed SHA header. Refer to the consolidated deployment inventory for current hash reconciliation.

Do not count these 59 historical assertions as newly executed checks. Their explicit limits remain: Manager live browser sessions, actual enrolled-factor challenge/recovery, committed production account/appointment writes and representative sign-off were not verified.

## Remaining requirements

T-031 has expanded independent local route/role/responsive evidence. Full authenticated production coverage of the remaining route/Manager matrix remains unverified; reuse of historical Owner/Staff focused checks does not erase that distinction. A release owner can authorize a bounded read-only run with an existing synthetic Manager and known synthetic clinic fixtures. No production account needs to be modified merely to test an existing role.

T-064 real hosted MFA challenge/recovery and any email-based account recovery remain external acceptance dependencies. Session loading/error/anonymous route behavior here uses synthetic Auth; it is not token-revocation proof. Real playback with authorized provider media remains separate from this recording-denial UI check. No provider media, patient recording, external calendar operation, Retell operation, production deployment or business write occurred.

Representative UAT and release-owner authorization remain required; browser evidence cannot provide their signatures.

## Completed actual hosted Owner/Staff follow-up

The strict closed-world metadata admission in `evidence/browser-hosted-fixture-admission.json` verified the exact existing synthetic clinic/client/practitioner/account allowlists. Unlisted clients/practitioners/members and all conversations, Requests, notes and notifications were absent; appointments referenced only the manifest client/practitioner. No clinical field was exported during admission. The actual deployed application then passed **60/60 route/role/viewport checks** (the ten listed routes × Owner/Staff ×1440/768/390) with zero page errors. Expected Staff denials, own-clinic rendering and page geometry passed; all business/provider/telemetry writes were blocked. See `evidence/browser-hosted-results.json` and `scripts/acceptance/hosted-dashboard-browser.mjs`.

The original70 checks recorded68 passes and two premature `input[type=password]` counts immediately after logout navigation. The later protected-route redirect and refresh-token rejection passed for both accounts even in that run. The harness now waits for visible form hydration, and a focused repeat passed **10/10** login/profile/logout/redirect/refresh-rejection checks; no product fix was needed. `evidence/browser-hosted-logout-focus.json` supersedes only the two incorrect timing assertions. The original evidence is retained, not relabeled as70/70. The repeated login/profile assertions are setup duplicates and must not be inflated into distinct feature coverage.

Four normal synthetic Auth sessions were issued across both executions, zero refreshes issued; all four were signed out with **local** scope and their captured refresh tokens rejected400. These Auth session writes are distinct from zero business/account/configuration mutations. No other user's sessions were invalidated. A later real expiry run completed5/5: the unchanged3600s token was rejected401 after3698s, normal refresh succeeded200 and same-clinic access recovered200. That fifth session then signed out locally204 and its captured refresh was rejected. See evidence/hosted-session-expiry.json. Total current hosted Auth operations: five synthetic sign-ins, one refresh, five local sign-outs. This adds API expiry/recovery proof; it is not an automatic browser-refresh or hosted MFA claim. Full deployed Manager coverage remains unavailable; no account role was changed to manufacture that fixture. The read-only production routes cover actual file-route wiring and hydration for Owner/Staff, while the earlier isolated component scope remains as documented.
