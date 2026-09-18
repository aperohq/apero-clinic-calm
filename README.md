# Apero Clinic Frontend

Build the Apero AI Receptionist & Clinic Operations web application frontend based strictly on the approved Google Stitch export in the attached zip.

Follow all Phase 1 specifications:
1. Design & Layout: Match the Stitch design ('Clinical Calm' system: #F7F7F7 canvas, #111827 carbon slate, #10B981 emerald, #F59E0B amber, #E5E7EB borders, 10px/12px/16px radius, Inter typography). Use vector SVGs for Apero wordmark and Dental Zone Clinic badge.
2. Structure & Routing: Single React application with AppLayout shell and routes:
   - /login (mock sign-in and forgot password modal)
   - /home (KPI cards, Needs your attention, Next Appointment, Recent Conversations, Apero Active status)
   - /calendar (weekly view, filter by staff, interactive modals for New Appointment, Details, Reschedule, Cancel, Time Off)
   - /clients (searchable client roster)
   - /clients/:id (client details, upcoming/history appointments, call history, internal notes)
   - /staff (team directory grouped by specialty)
   - /staff/:id (staff details, weekly schedule/hours editor, assigned services, upcoming appointments)
   - /conversations (call logs with status, caller, duration, filters)
   - /conversations/:id (summary, key collected details, recording audio player UI, full dual-sided transcript)
   - /billing (current plan with '$— / month', renewal date, payment method card, invoice list with download mock)
   - /account (profile information, change password with live rule checks, sign-out modal)
   - /support (dedicated support form with all 9 categories, success state, official contact apero.hq@gmail.com)
3. Navigation: Desktop sidebar, collapsible tablet rail, mobile hamburger drawer. Sidebar: 'Apero', static 'Dental Zone Clinic' (not a dropdown), Home, OPERATIONS (Calendar, Clients, Staff, Conversations), Billing, then Support, Account / Profile, Log out. No Setup or AI Receptionist menu items.
4. Data Consistency: Centralized mock data layer linking clients, staff, appointments, conversations, and billing records across all views.
5. Terminology: Clean clinic-facing language ('Clients', 'Booked by Apero', 'Needs Review'). No EHR, SIP, Asterisk, or technical AI engine terminology.
6. Frontend only: All forms, modals, tabs, and interactive states working with mock state.

This project was built with [Lovable](https://lovable.dev).

**Live app**: https://aperodashboard.lovable.app

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/3b5becb4-5abb-4036-88de-de2fea1261b4).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
