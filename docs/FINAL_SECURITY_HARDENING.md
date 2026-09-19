# Final small security hardening — 2026-09-19

## Voice endpoints

The three tool endpoints now accept at most 128 KiB per request. `retell-webhook` accepts 2 MiB because completed-call events can include transcripts. Both declared and streamed sizes are checked before JSON parsing. Requests over the limit receive HTTP 413. Retell signature verification still uses the exact raw bytes after the bounded read.

No in-memory application rate limiter was added: Edge instances are distributed and ephemeral, so it would be inconsistent and could reject legitimate Retell retries. Signatures remain the primary admission control. Booking and request idempotency remain the write-spam controls. Monitor 401/413/5xx volume and use Supabase/platform gateway limits if sustained signed abuse occurs.

## Logging and recordings

Edge database failures now log only a fixed operation label and database error code. Logs no longer include raw database error objects, call IDs, invalid shift rows, payloads, transcripts, names, phone numbers, authorization headers, or secrets.

The webhook copies Retell's `call.recording_url` into the clinic-isolated `conversations` row and the browser uses that URL directly in an audio element. Existing production URLs use an opaque CloudFront host with no query string. This shows they are not conventional query-signed URLs; repository code cannot establish Retell's expiry or access policy. Treat each URL as a bearer capability: anyone who obtains it may be able to play the recording. Confirm retention, sharing, and URL lifetime in Retell before expanding access. A proxy/download architecture was not introduced because it would change playback and storage design.

## Headers and HTTPS

Lovable/Cloudflare currently supplies HTTPS, HSTS, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: strict-origin-when-cross-origin`. Header control is not declared in this repository; the generated `_headers` file contains only asset caching. No CSP or frame header was added because Lovable editor framing and direct Retell/CloudFront audio must be tested against a real policy.

### Cloudflare later

1. Preserve HTTPS redirect and HSTS after custom-domain cutover.
2. Add `Permissions-Policy: camera=(), geolocation=(), payment=()`; include `microphone=()` only while the dashboard has no browser voice feature.
3. Add CSP in report-only mode first. At minimum account for the app origin, Supabase HTTPS/WebSocket endpoints, Google Fonts, and the verified Retell recording host under `media-src`. Move to enforcement only after login, reset, all routes, and audio playback pass.
4. Prefer CSP `frame-ancestors 'none'` after confirming the production app does not need Lovable/editor framing. An `X-Frame-Options: DENY` fallback may be added at that point.
5. Apply coarse abuse rules only to the custom frontend hostname. Do not place browser-oriented challenges in front of Supabase Retell webhook/function URLs.

## Auth abuse controls

Supabase Auth remains responsible for login and reset abuse protection. Live settings show email-send rate limit 2, OTP/verify rate limit 30, token-refresh rate limit 150, and CAPTCHA disabled. Password reset has been tested successfully. Before adding CAPTCHA, monitor failed-login and reset volume. If abuse appears, enable Supabase-supported CAPTCHA in Auth settings and test login and recovery; do not build a parallel auth system.
