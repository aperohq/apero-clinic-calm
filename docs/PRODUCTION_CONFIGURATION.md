# Apero production configuration — 2026-09-19

## AUTOMATICALLY VERIFIED

- Current frontend: `https://aperodashboard.lovable.app`. The reset route is `/reset-password`; `resetPasswordForEmail` uses `window.location.origin + "/reset-password"`. The recovery page requires a Supabase session and the `PASSWORD_RECOVERY` event before allowing a password update.
- Supabase project: `svoybvzvmygszklcmudh`, URL `https://svoybvzvmygszklcmudh.supabase.co`. The checked-in browser key has the `sb_publishable_` prefix. `VITE_SUPABASE_PROJECT_ID` is unused; the non-VITE copies of URL and publishable key support server code. `SUPABASE_SERVICE_ROLE_KEY` is referenced only by server code. No secret value was found in public assets; the `sb_secret_` text there is a Supabase SDK prefix check, not a key. No public source maps were built.
- Live Auth recheck on 2026-09-19 after the manual fix: Site URL is `https://aperodashboard.lovable.app` and the redirect allow list is `https://aperodashboard.lovable.app/reset-password`. Password recovery was tested successfully. Email login is enabled and email autoconfirm is false. Custom SMTP was previously found unset; sender configuration and ongoing delivery monitoring remain operational checks.
- The dashboard calls Supabase Auth and PostgREST directly. Voice functions are Retell/server endpoints and contain no browser CORS handling. They use signed Retell requests and `voice_integrations` lookup, rather than a browser cookie or client-supplied clinic selector. A future frontend domain does not require a voice function CORS change. Supabase's Auth/PostgREST gateway handles browser CORS.
- Routes exist for `/login`, `/home`, `/calendar`, `/clients`, `/clients/:id`, `/staff`, `/staff/:id`, `/conversations`, `/conversations/:id`, `/account`, `/support`, `/privacy`, `/terms`, and `/reset-password`. There are no Billing, Chat, or Integrations routes. Protected UI uses the session, authenticated profile, and profile clinic ID. Session persistence and refresh are enabled; sign-out calls Supabase Auth. Browser and RLS acceptance remain necessary because UI guards alone do not authorize database access.
- Local build succeeds with Apero title, metadata and favicon. Localhost references in preview auth storage and test fixtures are development support. No stale production frontend URL was found. Database migration files are numbered 01–06; there is no 07 file. Existing voice reconciliation records migration 05 and the four deployed functions.

## MANUAL SUPABASE DASHBOARD CHECK

In project `svoybvzvmygszklcmudh` → Authentication → URL Configuration, retain Site URL `https://aperodashboard.lovable.app` and redirect URL `https://aperodashboard.lovable.app/reset-password`. Login and logout are in-app and need no separate callback URL.

In Authentication → Email Templates, confirm the recovery template keeps `{{ .ConfirmationURL }}`. In Authentication → Providers/Email, confirm confirmation policy. In Project Settings → Authentication/SMTP, verify the sender and quota. Live API showed custom SMTP unset, so default Supabase mail is the current apparent path; it has delivery and rate-limit constraints and must be tested with an approved real account. Perform one end-to-end forgot-password email, recovery-session, and password-update test. Do not infer delivery from a successful reset request.

In Edge Functions → Secrets, confirm `RETELL_API_KEY` exists (value must stay secret), together with Supabase runtime-provided URL and service-role credentials. Migration 05 stores only the `RETELL_API_KEY` **name** in `voice_integrations`. Check function versions and `verify_jwt`/Retell signature setup for `clinic-operations`, `retell-webhook`, `check-availability`, and `book-appointment`. The expected base is `https://svoybvzvmygszklcmudh.supabase.co/functions/v1/`.

In Database → Migrations and Table Editor/Policies, confirm 03–06 are applied, 07 is absent, RLS is enabled on browser-facing tables, and `voice_integrations`, `clinic_service_aliases`, and voice state/operations tables have no anon/authenticated grants. The repository SQL and prior reconciliation support this design; this pass did not re-query all live policies.

## MANUAL RETELL DASHBOARD CHECK

In Dental Zone's published agent/flow, verify each of the 10 active tool URLs is `https://svoybvzvmygszklcmudh.supabase.co/functions/v1/clinic-operations`, with no Cal.com or preview URL. In Retell workspace settings → Webhooks, verify destination `https://svoybvzvmygszklcmudh.supabase.co/functions/v1/retell-webhook` and the intended events. This pass did not publish or change Retell.

## MANUAL LOVABLE/BROWSER CHECK

Open every route above by direct navigation and refresh, including representative `:id` paths. Check unauthenticated denial, login, session persistence, expiry, logout, role access, and clinic isolation with two authorized accounts if available. Check invalid/expired reset links and a real delivered reset. Check failed reads/writes and unavailable recordings/transcripts show safe messages. Confirm Lovable's published production build matches this commit after sync. No appointments need to be created for route checks.

## FUTURE DOMAIN CHECK — CUSTOM DOMAIN CUTOVER

1. Choose the final hostname, then use Lovable's custom-domain instructions to obtain the exact DNS target. Create the required Cloudflare DNS record, complete ownership verification, and wait for valid TLS. Do not guess the DNS target or use a placeholder hostname in live settings.
2. Verify direct navigation and refresh for all routes on the new hostname before announcing it.
3. Set Supabase Auth Site URL to the final `https://app.<future-domain>` value. Add the exact `https://app.<future-domain>/reset-password` redirect. Retain the Lovable reset redirect only during transition if needed; later remove unused origins.
4. The app derives password-reset redirects from the active browser origin; request and complete a new reset on the custom hostname. Review sender branding and deliverability.
5. Browser requests use the same Supabase URL and publishable key. No Apero voice function CORS allow list currently needs updating. If a future browser-facing Edge Function adds an explicit origin list, add the exact new origin there. Do not add wildcard credentialed CORS.
6. Retell tools and webhook use Supabase function URLs, so a frontend-only domain switch does not require changing them. Recheck their configured URLs after cutover.
7. Update README, support/legal links, and hosting environment configuration only where the final hostname is actually referenced. Keep server secrets out of `VITE_*` variables.
