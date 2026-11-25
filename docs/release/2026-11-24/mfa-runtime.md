# Isolated actual MFA runtime acceptance — T-064

**21/21 assertions PASS**, including setup/isolation assertions. This is a real standalone Supabase Auth process and its native PostgreSQL state, not a mocked enrollment/challenge API. It expands the independent technical evidence; **it does not close hosted Apero MFA enrollment/challenge/recovery or define a clinic recovery policy**.

Executed November25,2026 UTC using the official `supabase/auth` **v2.198.0** amd64 release. GitHub's asset SHA256 `4abe9134d7615faa9149cab514acada8e7133cd69d2ccd96fdcef0d795c05171` matched the downloaded archive. Extracted binary SHA256 and exact harness source hash are recorded in [provenance](evidence/mfa-tool-provenance.json). Fresh public production health also identifies **v2.198.0**: [production version evidence](evidence/production-auth-version.json). That is version-tag parity, not independently proven binary/configuration parity.

## What actually ran

[`scripts/acceptance/isolated-mfa-runtime.mjs`](../../../scripts/acceptance/isolated-mfa-runtime.mjs) initialized a new disposable PostgreSQL16.15 cluster under private `/dev/shm`, applied the native Auth binary's **77 Auth migrations**, then served the actual Auth REST API inside an unprivileged user/network namespace. The namespace had only loopback, no external route and exactly two TCP listeners bound to `127.0.0.1`: Auth and a no-delivery SMTP connection trap. PostgreSQL used its private Unix socket; no existing database or production credentials were loaded.

All API credentials, password, JWT signing key, factor seeds, QR representation, TOTP codes and issued token material were synthetic and stayed in memory or the disposable tmpfs database. No real email/SMS transport was used; SMTP trap connections were **zero**. TOTP enrollment/verification remained enabled; normal challenge expiry, verification restrictions, factor limits and anti-replay behavior were not disabled to make tests pass. The expired challenge fixture backdated only its exact isolated `created_at` row by ten minutes; the server's expiry policy was unchanged.

| Scenario                                                                    | Actual outcome                                                                                                                                                                                         |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Namespace, migrations, health, listener binding and synthetic user creation | Five setup/isolation assertions passed; actual local Admin API created one confirmed invented identity without sending mail                                                                            |
| First-factor sign-in                                                        | HTTP200; server-issued JWT AAL1                                                                                                                                                                        |
| Primary TOTP enrollment                                                     | HTTP200; provider issued factor/secret only to in-memory test client                                                                                                                                   |
| Wrong verification code                                                     | HTTP422 `mfa_verification_failed`; no successful step-up                                                                                                                                               |
| Expired challenge                                                           | HTTP422 `mfa_challenge_expired`; no expiry-policy shortening                                                                                                                                           |
| Correct primary challenge                                                   | HTTP200; server-issued JWT AAL2                                                                                                                                                                        |
| Reusing an already verified challenge                                       | HTTP422; provider's stable error code was `mfa_ip_address_mismatch` because the same validation branch rejects previously verified challenges; it is not claimed to be an independent IP-spoofing test |
| Backup factor enrollment and verification                                   | HTTP200; second verified factor and AAL2; actual user API listed two verified factors                                                                                                                  |
| Subsequent password sign-in                                                 | HTTP200 and AAL1, proving password-only login does not itself establish second-factor verification                                                                                                     |
| Removing a verified factor from AAL1                                        | HTTP422 `insufficient_aal`                                                                                                                                                                             |
| Simulated lost-primary recovery                                             | After the next normal TOTP interval, the pre-enrolled backup factor established AAL2. The authenticated user removed only the primary factor; the backup remained verified                             |
| Local session sign-out                                                      | HTTP204; captured refresh token subsequently rejected HTTP400                                                                                                                                          |
| Mail/SMS side effects                                                       | Zero SMTP connections; phone factor/provider not configured; no outbound route                                                                                                                         |

The terminal [runtime evidence](evidence/mfa-runtime.json) contains exactly21 PASS assertions: five setup/isolation, fifteen Auth/MFA protocol behavior and one no-mail assertion. Do not count this as21 application features or add the earlier partial runs. [Run log](evidence/mfa-runtime-run.txt), [ESLint](evidence/mfa-runtime-lint.txt) and [format check](evidence/mfa-runtime-format.txt) are separate supporting evidence.

Initial attempts exposed harness bootstrap requirements: health alone does not apply migrations; the native migration runner expects the existing `auth` namespace and `postgres` role; model queries require the Auth role's `search_path=auth,public`. The initial invalid-code assertion also read the legacy numeric `code` instead of `error_code`. These isolated fixture/assertion corrections produced no Apero application or production fix. Every attempted cluster was stopped and removed; only the terminal complete run is accepted.

## Cleanup and limits

The local Admin API deleted the exact synthetic identity. Independent database counts then showed **zero users, factors and sessions**. The Auth process exited and its PID was absent; PostgreSQL stopped, its Unix socket was absent, and the complete tmpfs cluster/private directory was removed. Each cleanup result is explicit in `mfa-runtime.json`.

This test exercises a supported **pre-enrolled backup-factor mechanism** for an invented local identity. No recovery codes were generated, no actual clinic recovery policy was invented and no real owner or production factor was changed. It does not demonstrate mailbox delivery, real founder-owner recovery, cross-device possession, actual Apero enrollment/challenge screens or Apero AAL-based enforcement. The current dashboard exposes factor/assurance readiness only; genuine hosted owner enrollment/challenge/recovery and any required application flow/enforcement remain separate release gates.

Reproduce with the recorded official binary/archive under `/tmp/apero-mfa-tools`, existing native PostgreSQL tools, `unshare`, `ip` and `ss`, then:

```sh
TMPDIR=/dev/shm \
LD_LIBRARY_PATH=/tmp/apero-onboarding-tooling/postgres/usr/lib/x86_64-linux-gnu:/tmp/apero-final-native/usr/lib/x86_64-linux-gnu \
APERO_TEST_PG_BIN=/tmp/apero-onboarding-tooling/postgres/usr/lib/postgresql/16/bin \
node scripts/acceptance/isolated-mfa-runtime.mjs
```

No new repository dependency, hosted project, system service, production mutation, real message, paid API or Retell operation was used. Tool provenance: [official Auth release](https://github.com/supabase/auth/releases/tag/v2.198.0); API concepts: [official TOTP guide](https://supabase.com/docs/guides/auth/auth-mfa/totp), [official Auth source/standalone configuration](https://github.com/supabase/auth/tree/v2.198.0).
