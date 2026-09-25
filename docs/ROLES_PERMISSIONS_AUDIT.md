# Clinic roles and permissions audit

Reviewed 2026-09-25 against the dashboard source and read-only metadata from the deployed Supabase project. This describes **current deployed behavior**. The proposed `db/09_client_notes_restrict_update.sql` is not applied, so the note-update finding below remains active.

## Model and notation

Supabase Auth authenticates a user; one `profiles` row maps that Auth user to one `clinic_id` and one `profile_role` enum value: `owner`, `manager`, or `staff`. There is no user-management UI or granular permission table. The browser uses a publishable key and the user's session; RLS is the data boundary. `RouteShell` gates routes, while action controls have their own visibility checks where noted.

Each role cell reads **visible / frontend permitted / database permitted / effective**. “Visible” means a route or control is reachable in the UI. “Frontend permitted” means the route or action passes the existing frontend gate; `—` means no frontend action exists. “API only” means a direct authenticated Supabase request works despite no UI. “No” means the operation is denied or absent. All database rows below have RLS enabled unless marked `n/a`. Database permissions shown include grants **and** RLS.

| Route or action | Owner | Manager | Staff | RLS / scope |
| --- | --- | --- | --- | --- |
| Home | Yes / Yes / read / Yes | Yes / Yes / read / Yes | Yes / Yes / read / Yes | Clinic data; Requests subpanel only owner/manager |
| Calendar view | Yes / Yes / read / Yes | Yes / Yes / read / Yes | Yes / Yes / read / Yes | Clinic appointments, staff, clients |
| Clients list | Yes / Yes / read / Yes | Yes / Yes / read / Yes | Yes / Yes / read / Yes | Own clinic |
| Client detail | Yes / Yes / read / Yes | Yes / Yes / read / Yes | Yes / Yes / read / Yes | Own clinic; notes and call history also readable |
| Staff list | Yes / Yes / read / Yes | Yes / Yes / read / Yes | No / No / read / API only | Own clinic; staff route denied in frontend |
| Staff creation | Yes / Yes / insert/RPC / Yes | Yes / Yes / insert/RPC / Yes | No / No / no / No | Own clinic and owner/manager role; invoker RPC checks role |
| Staff editing | Yes / Yes / update / Yes | Yes / Yes / update / Yes | No / No / no / No | Own clinic and owner/manager role |
| Staff schedules | Yes / Yes / read/write / Yes | Yes / Yes / read/write / Yes | No / No / read / API read only | Own clinic; writes owner/manager only |
| Staff time off | Yes / Yes / read/write / Yes | Yes / Yes / read/write / Yes | No / No / read / API read only | Own clinic; writes owner/manager only |
| Conversations list | Yes / Yes / read / Yes | Yes / Yes / read / Yes | Yes / Yes / read / Yes | All calls in own clinic, not a per-staff subset |
| Conversation detail | Yes / Yes / read / Yes | Yes / Yes / read / Yes | Yes / Yes / read / Yes | Own clinic, including transcript/recording URL |
| Requests | Yes / Yes / read / Yes | Yes / Yes / read / Yes | No / No / no / No | Own clinic and owner/manager role |
| Mark request handled | Yes / Yes / status update / Yes | Yes / Yes / status update / Yes | No / No / no / No | Own clinic and owner/manager; only `status` has update grant |
| Add client note | Yes / Yes / insert / Yes | Yes / Yes / insert / Yes | Yes / Yes / insert / Yes | Own clinic; author must be current profile |
| Edit client note | No / — / update / API only | No / — / update / API only | No / — / update / API only | Own clinic; author/client/clinic immutable, note text mutable **until 09 applied** |
| Delete client note | No / — / delete / API only | No / — / delete / API only | No / — / no / No | Own clinic and owner/manager role |
| Create appointment | Yes / Yes / insert / Yes | Yes / Yes / insert / Yes | Yes / Yes / insert / Yes | Own clinic; referenced client/staff must match clinic |
| Edit other appointment fields | No / — / update / API only | No / — / update / API only | No / — / update / API only | Own clinic; all appointment columns currently updatable |
| Reschedule appointment | Yes / Yes / update / Yes | Yes / Yes / update / Yes | Yes / Yes / update / Yes | Own clinic |
| Cancel appointment | Yes / Yes / update / Yes | Yes / Yes / update / Yes | Yes / Yes / update / Yes | Own clinic; UI sets status `Cancelled` |
| Delete appointment | No / — / delete / API only | No / — / delete / API only | No / — / no / No | Own clinic and owner/manager role |
| Account/profile | Yes / Yes / own update / Yes | Yes / Yes / own update / Yes | Yes / Yes / own update / Yes | Own profile; identity/role/clinic/email guarded; password uses Supabase Auth |
| Support | Yes / Yes / n/a / Yes | Yes / Yes / n/a / Yes | Yes / Yes / n/a / Yes | Mailto link; no database write |
| Clinic configuration | No / — / update / API only | No / — / no / No | No / — / no / No | Own clinic; owner-only update policy |
| Voice integration/config data | No / — / no / No | No / — / no / No | No / — / no / No | RLS and grants deny browser roles; service role only |
| Billing/subscription | No / — / n/a / No | No / — / n/a / No | No / — / n/a / No | No implemented billing route or table found |
| Manage login users/roles | No / — / no / No | No / — / no / No | No / — / no / No | Profile insert/delete lacks RLS policy; role/clinic/Auth identity changes blocked by trigger |

Client contact editing is visible to **all three roles** and allowed by the `clients` update policy. Adding a client is visible and permitted only for owner/manager. A direct API request can also update a client's other same-clinic fields, including `notes`; the frontend does not offer all of those edits.

## Boundaries verified

- Deployed RLS is enabled for all clinic tables inspected. `current_clinic_id()` derives the clinic from `auth.uid()`; select/write policies scope rows to it. Cross-clinic references in appointments, notes, notifications, staff availability, and time off have deployed guards or composite foreign keys.
- The deployed profile trigger rejects browser changes to `role`, `clinic_id`, `auth_user_id`, and email. An authenticated user's profile update policy selects only their own row. No browser policy inserts or deletes profiles.
- Staff cannot write staff, schedules, time off, or request status through direct Supabase access. Manager and owner can write operational staff records, but cannot write voice integration rows or call records.
- `create_staff_with_schedule` is `SECURITY INVOKER` and explicitly checks owner/manager. `voice_apply_appointment` is `SECURITY DEFINER` but executable by service role only. The Retell Edge Functions derive clinic identity from a verified signature and active integration, not a caller-supplied clinic ID.
- The deployed conversation table has only browser `SELECT`; browser inserts/updates/deletes were revoked. The request table has browser `SELECT` plus column-level `UPDATE(status)`; RLS limits both to owner/manager in their clinic.
- The four voice Edge Functions are deployed and active with platform JWT verification disabled. The checked-in handlers verify the Retell signature before using the service-role client; deployed function source was not compared byte-for-byte in this audit.

These are metadata and source checks, not a live impersonation test with real user sessions. No production row was inserted, updated, or deleted.

## Findings and classification

1. **Security issue — client note integrity:** every role can directly rewrite another same-clinic note's text. The UI only supports adding notes. Migration 09 removes authenticated `UPDATE` and its policy, preserving reads/inserts and existing rows. It needs separate review and application.
2. **Product gap — owner user management:** an owner cannot create login accounts, assign roles, or remove users in the dashboard. The `staff` table represents practitioners, not Auth users. This is a current owner-model gap.
3. **Product policy gap — manager staff control:** managers currently have the same practitioner creation/edit/scheduling access as owners. The intended model does not yet say whether that should remain true.
4. **Future granular-permissions feature — relevance and action scope:** staff see all clinic calls/clients and can edit client contacts and all appointment columns through direct API requests. The intended model does not define a per-staff visibility rule or field-level appointment/client permissions, so these were not changed.
   All three roles can also directly read same-clinic profile names, emails, and roles, although no user directory is displayed. Decide whether staff need that directory data before narrowing its policy.
5. **Harmless UI/API inconsistency:** staff cannot open the Staff route but can read same-clinic staff/schedule data through the API, which Calendar and detail views need. Owner clinic settings are API-only. Owners/managers can use direct API to change request status to any currently allowed enum value, while the UI only marks Closed.
6. **Future product gap:** billing and integrations remain unbuilt/hidden and browser roles cannot manage voice configuration. They are not launch blockers on their own.

Treat finding 1 as the permission issue to resolve before launch: until migration 09 is reviewed and applied, a signed-in staff user can alter the text of another staff member's note through the direct API. The broader staff visibility and manager scope questions need a product decision before changing policies.

The untracked `db/08_voice_requests_handling.sql` exists in the workspace and its request-status grant/policy are present in the deployed database. It was not changed or committed in this audit.

## Smallest future owner-controlled permission design

Keep Auth identity and clinic-scoped RLS. Define a short action catalog, owner-managed assignments, and a single database authorization helper used by policies/RPCs. Decide first whether grants attach to users or roles, which actions need individual toggles, whether managers may manage users, and whether explicit grants/denials can override role defaults. Do not implement this before those decisions are made.
