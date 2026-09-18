# Apero production readiness — 2026-09-18

## Confirmed configuration

- The frontend uses `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`; the checked-in `.env` contains only the publishable key and project URL. Server-only code reads `SUPABASE_SERVICE_ROLE_KEY`. No service-role or Retell secret value was found in the built public assets. Publishable keys are expected to be visible to browsers; RLS is the data boundary.
- The favicon is `public/favicon.svg`; route titles and descriptions use Apero. The old Dental Zone-specific route metadata has been removed from visible pages. No public `.map` source-map files were found in the production build.
- Supabase Edge Functions are called by Retell/server requests; no browser CORS dependency for those voice endpoints was found in the current dashboard. The dashboard calls Supabase Auth and PostgREST directly from the browser.
- The current live frontend URL is `https://aperodashboard.lovable.app` (confirmed by the owner). No custom domain is assumed.

## Required before Dental Zone launch

1. **Complete voice acceptance with a controlled call.** Migration 05 and all four current Edge Functions are live. Signed read-only and synthetic availability checks passed, but a real Retell-delivered webhook, completed booking/reschedule/cancel, and message/callback/urgent persistence were deliberately not generated in production. Confirm Retell's account-level webhook destination in its dashboard; the agent API response does not expose it. See `docs/VOICE_RECONCILIATION.md`.
2. **Confirm password-reset delivery.** In Supabase Auth, set the current production site URL and allow the exact `https://aperodashboard.lovable.app/reset-password` redirect. Verify the configured email sender/template and use a real clinic account to complete an end-to-end reset. The app derives its redirect from `window.location.origin`.
3. **Approve clinic content and legal drafts.** Confirm staff identities, services, working days/hours, and phone numbers. Review `/privacy` and `/terms` with the owner/legal reviewer as described in `docs/LAUNCH_BASICS_CONFIG.md`.
4. **Browser acceptance.** Test owner role writes and refresh, staff read-only schedule access, auth expiry, recording/transcript states, clinic-time appointment creation/reschedule/cancel with safe approved records, and mobile/tablet widths.

Known demo/test operational clients, appointments, conversations, notes, and voice requests are expected. The owner plans to remove them immediately before clinic handoff. Preserve clinic, real staff, services, working hours, time off, and voice configuration during that cleanup.

The synchronization left one clearly named internal `voice_call_state` fixture and ten expiring `voice_checked_slots` rows. It created no appointment, conversation, or voice request. These internal fixture rows can be included in the planned operational-data cleanup; do not remove clinic configuration.

## When a custom domain is purchased

1. Point the new domain to the chosen frontend deployment and verify TLS, direct route refresh, favicon, metadata and redirects.
2. Update Supabase Auth site URL and redirect allow list for `https://<new-domain>/reset-password`; retain only intended preview/current URLs. Test reset email links on the new origin before changing clinic communications.
3. Update README and any public support or legal references to the actual domain. Keep Supabase project URL and publishable key tied to the intended production project; do not put service-role or Retell keys in `VITE_*` variables.
4. Retest browser sign-in/session persistence and Retell webhook/tool endpoints. The voice endpoints use Supabase function URLs, so a frontend domain change alone should not change their endpoint addresses.

## Operational limits

The current dashboard does not expose `voice_requests` as a separate queue. The webhook's “Follow-up Needed” conversation outcome is now surfaced in Home attention when the webhook succeeds, but request status management and urgent routing still need an owner-approved operational process. Dashboard appointment creation is a manual front-desk action and does not enforce working hours/time off; staff overlap is enforced by the database. Confirm whether manual exceptions are intended before launch.
