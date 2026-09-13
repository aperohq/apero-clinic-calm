# Apero Phase 1

- [x] Clinical Calm visual system and responsive application shell
- [x] Centralized linked clinic mock data
- [x] Login, home, calendar, clients, staff, conversations, billing, account, and support routes
- [x] Detail views for clients, staff, and conversations
- [x] Requested mock dialogs, filters, forms, status states, and downloads
- [x] Final desktop, tablet, and mobile interaction verification

## Interaction fix pass

- [x] Add Client form with validation, saved records, search, and detail page
- [x] Add Staff Member form with validation, saved records, search, and detail page
- [x] Success/placeholder feedback messages across every clickable control
- [x] Calendar week navigation, Today, staff filter, and appointment dialogs
- [x] Billing subscription, payment method, and sample invoice download feedback
- [x] Mobile/tablet layout checks for schedule rows and recording player

Waiting on a future backend: real payments, live invoices, call audio, visit
records, and permanent storage for new clients and staff.

## Phase 2 — Supabase backend (this pass)
- [x] Env-based shared Supabase client (VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY)
- [x] Real auth: sign in, sign out, forgot password, reset password, persistent session, protected routes
- [x] Multi-clinic schema + RLS SQL in db/01_phase2_schema.sql (clinics, profiles, clients, staff, staff_availability, appointments, conversations, client_notes, notifications)
- [x] Role-based navigation (owner / manager / staff)
- [x] localStorage data layer replaced with Supabase queries and mutations
- [ ] Blocked on user: run db/01_phase2_schema.sql, create the apero.hq@gmail.com auth user, run db/02_link_owner_profile.sql
- [ ] Still mocked: billing plan, payment method, invoices; call recording playback
