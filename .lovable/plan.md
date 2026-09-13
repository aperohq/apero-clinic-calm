# Apero Phase 1 Frontend

## Goal
Build the complete Apero clinic operations application from the approved Stitch export, using the Clinical Calm visual system and a shared mock-data model. The experience will work across desktop, tablet, and mobile, with no backend or real payment, email, audio, authentication, or download integrations.

## App foundation
- Replace the placeholder home screen and define the Clinical Calm tokens in the global stylesheet: Inter, neutral canvas and surfaces, carbon text, emerald/amber/red statuses, precise borders, shadows, and 10/12/16px radii.
- Recreate the Apero wordmark and Dental Zone Clinic badge as local vector React components based on the approved export.
- Add a responsive `AppLayout`: fixed desktop sidebar, collapsible tablet icon rail, mobile hamburger drawer, page header, clinic identity, profile controls, and active-route highlighting.
- Keep `/login` outside the application shell and route `/` to the mock sign-in or home experience consistently.

## Shared data and behavior
- Create one typed mock-data module linking clients, staff, appointments, conversations, notes, services, invoices, and clinic/account details by stable IDs.
- Add lightweight in-memory state for additions and edits so changes appear consistently across related screens during the session.
- Build reusable status badges, page headings, tables/lists, empty states, form fields, dialogs, tabs, timeline items, and responsive data rows using the existing UI components.
- Use clinic-facing terminology throughout, including “Clients,” “Booked by Apero,” and “Needs Review.”

## Routes and screens
- **`/login`**: approved sign-in layout, validation/error state, remembered email state, mock Google/sign-in actions, and forgot-password dialog with sent confirmation.
- **`/home`**: approved KPI overview, Needs your attention queue, next appointment, recent conversations, and Apero Active status.
- **`/calendar`**: weekly calendar, date navigation, staff filter, appointment blocks, and working dialogs for new appointment, details, reschedule, cancellation, and time off.
- **`/clients`**: searchable/filterable roster with linked client rows.
- **`/clients/$id`**: profile and contact details, upcoming appointment, appointment history, call history, internal notes, and working note/profile/appointment actions.
- **`/staff`**: team directory grouped by specialty with linked staff cards/rows.
- **`/staff/$id`**: provider profile, weekly hours editor, time-off state, assigned services, and upcoming appointments.
- **`/conversations`**: searchable/filterable call log with status, caller, reason, duration, and linked details.
- **`/conversations/$id`**: summary, collected details, mock recording player, complete dual-sided transcript, client card, and related appointment state.
- **`/billing`**: current plan shown as `$— / month`, renewal date, payment method, invoice history, and mock invoice downloads.
- **`/account`**: editable profile, password form with live requirement checks, save feedback, and sign-out confirmation.
- **`/support`**: dedicated support form with all nine categories, contact address `apero.hq@gmail.com`, validation, and success state.

## Navigation and route metadata
- Sidebar order: Apero and static Dental Zone Clinic identity; Home; Operations with Calendar, Clients, Staff, Conversations; Billing; then Support, Account / Profile, and Log out.
- Do not add Setup or AI Receptionist navigation items.
- Add unique titles, descriptions, Open Graph text, and social-card metadata for every route.

## Validation
- Check every route for loading and navigation errors.
- Exercise all requested dialogs, forms, filters, tabs, password rules, calendar actions, mock downloads, sign-in/sign-out, and support success state.
- Visually verify representative desktop, tablet, and mobile screens against the approved Stitch references, including sidebar/rail/drawer behavior and non-overlapping text.
