# Authorized recording playback

Implemented locally on 2026-10-04. No remote configuration, migration, provider
call, production-data cleanup, or deployment was performed.

## Access flow

1. The player POSTs only `{ conversationId }` to `recording-access` with the
   current Supabase bearer token through `functions.invoke`.
2. The Edge function validates the bearer with Auth `getUser`. Its user-scoped
   client reads the live profile and rejects missing/revoked membership or a
   role outside Owner/Manager/Staff (the current conversation-reading roles).
3. It selects that conversation by ID and the authenticated profile's clinic
   using the user's JWT. Existing conversation RLS remains effective.
4. A server-only service-role read resolves the active voice integration for
   that clinic and the conversation's saved agent ID. The workspace credential
   comes from that integration's existing `secret_env_name` environment variable.
5. It calls `GET https://api.retellai.com/v2/get-call/{saved_call_id}` and checks
   the returned call and agent IDs. Neither a user-provided URL nor a user-provided
   call/clinic/agent ID can direct this provider request.
6. It returns only the fresh HTTPS recording URL when the call reports
   `opt_in_signed_url: true` and the URL contains query parameters. Unsigned,
   missing, malformed, or mismatched results fail closed. Supabase RLS is checked
   again after the provider request before returning access.
7. The player retains the credential only in component memory, discards it on
   account/clinic/role/conversation changes or logout, aborts stale requests,
   and permits a new authorized request after an expiry/playback error.

Responses use `Cache-Control: no-store`. Provider secrets, errors, transcripts,
and the provider's full call object are never returned. The endpoint performs
only reads. It does not modify a call to enable signing during playback.

## Retell behavior and limits

[Retell secure-URL documentation](https://docs.retellai.com/accounts/signed-secure-url)
states that requesting a secure call's recording regenerates a signed URL,
whose lifetime is stored with the call. It also states that files created before
signing was enabled continue to receive unsigned URLs. The supported
[Get Call endpoint](https://docs.retellai.com/api-references/get-call) supplies
the call identity, signing flag, and recording URL.

The reviewed reference and generator now set `opt_in_signed_url: true` and
`signed_url_expiration_ms: 300000` (five minutes). This is an intentional security
change to the pinned reference; its hash was updated without changing the call
flow. Historical deployment evidence remains unchanged.

Apero relies on authenticated Retell API responses to establish provider signing;
it does not implement or invent Retell's signature format. The returned URL is
still a bearer capability: copying it permits playback until provider expiry.
Already-issued links cannot be immediately revoked by Apero logout/membership
revocation. Historical signed calls retain their original configured lifetime;
do not assume this change shortens their links. The UI discards access after four
minutes and offers a fresh request, so a long recording may require reloading.

## Deployment and manual configuration

1. Deploy the frontend with the explicit conversation projection and authorized
   player. Coordinate with the column-grant migration; older frontends using
   `SELECT *` will fail after that migration is applied.
2. Apply `supabase/migrations/20261004140000_recording_access.sql` after existing
   schema/access/team prerequisites. It removes browser SELECT access to
   `conversations.recording_url`, including stale column grants. It preserves
   every row, every stored URL value, existing RLS policies, and service-role
   access. Do not subsequently replay migration 10: its table-wide conversation
   SELECT grant would re-expose the legacy column.
3. Deploy `recording-access` using its `deno.json` import map and `config.toml`
   entry. Platform `verify_jwt` is disabled because the handler independently
   validates the bearer. Supply existing `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
   `SUPABASE_SERVICE_ROLE_KEY`, and `APERO_PORTAL_ORIGIN` server configuration,
   plus each integration's existing Retell workspace secret environment variable.
   Never expose those secrets through VITE variables.
4. Deploy the updated `retell-webhook`. New rows store no playback URL. A later
   webhook update of an existing conversation clears only that row's legacy URL
   field; it does not remove its conversation, transcript, or Retell recording.
5. In each production Retell conversation-flow agent, open **Global settings →
   Security & fallback settings**, enable **Opt In Secure URLs**, and set
   **Expiration Time** to five minutes. Publish/select the configured version
   used by production calls. Generating a new master draft does not update an
   existing production agent. The API equivalents are documented in
   [Update Voice Agent](https://docs.retellai.com/api-references/update-agent).
6. Make an authorized synthetic call, confirm Get Call reports signing enabled,
   and verify playback for a member and denial for a different clinic. Confirm
   the provider denies the copied link after expiry and denies the unsigned
   path with signing parameters removed. No live acceptance call was made here.

## Existing recordings and cleanup

The migration **does not delete or clear any existing data**. Old URL fields
remain stored but cannot be selected by browser roles, including direct modified
Supabase queries. The new frontend never reads or uses them, and the new endpoint
does not offer unsigned legacy recordings.

This does **not** revoke an unsigned link already copied outside Apero, and changing
Retell's agent setting does not retroactively secure the old provider file.
Before real patient use, inventory affected legacy calls using a read-only,
clinic-scoped operator query returning conversation IDs, call IDs and a boolean
indicating URL presence; avoid exporting full playback URLs. There is no automatic
cleanup script or data-deleting migration in this change.

If retention is required, arrange a separately reviewed migration to private
storage with authenticated temporary access and verify the provider's old URLs
are revoked. Otherwise, ask Retell to revoke/remove the specifically inventoried
legacy recording files. Any operation deleting Retell calls may also delete
provider transcripts/logs: report exact call IDs, counts, and affected fields,
and obtain explicit deletion authorization first. Clearing database URL fields
alone would not secure already-copied links. Do not delete test or production
calls as part of deploying this implementation.
