# System downtime deployment — 2026-10-05

Only system downtime fallback was added. Completed specific helpers, provider integrations, RLS, roles, ownership, recording settings and transfer activation were preserved.

- Backend: clinic-operations **version 14 ACTIVE**; bundled and deployed after local validation. Existing retell-webhook **version 11 unchanged**, all other functions unchanged. No schema/configuration migration.
- Retell: primary agent and conversation flow **version 16 published**, based on 15. 162 nodes, including 26 current-result preparation nodes and the two-node terminal downtime path. Exact flow read-back verified. Voice/security/webhook/provider settings preserved.
- Local: **305 unique checks passed** (12 downtime helper, 31 real handler, 9 downtime flow, 209 existing reliability/SQL/RLS, 44 existing flow checks); 9 additional preservation checks against the fresh published version-15 baseline passed. Helper TypeScript check and diff whitespace check passed. Additive integration with the existing dirty workspace also passed.
- Production smoke: signed current receipt returned; invalid signature rejected. Read-only, no Requests or patient writes, no paid calls. Existing clinic phone is present, fallback_phone absent; no number populated. Existing live transfer remains disabled.
- Frontend: no UI change or new Lovable publication needed. Source release on main is the reproducible backend/Retell implementation; no rewrite of pushed history. Existing workspace changes were preserved.
- Deferred: actual audio/telephony acceptance, total Retell outage routing and provider-level failure handling. Final SIP provider, verified Dental Zone destination and provider-native unavailable routing remain blocked/unconfigured.

Patient wording, priority, logging and provider limitations: [system-downtime.md](system-downtime.md). Safe release evidence: [system-downtime-evidence.json](system-downtime-evidence.json).

## Changed files

- supabase/functions/_shared/system-downtime.ts
- supabase/functions/clinic-operations/index.ts
- retell/system-downtime.py
- retell/master/tests/edge-isolation.test.mjs
- tests/system-downtime.test.mjs
- tests/test_downtime_flow.py
- package.json (test command only)
- docs/security/system-downtime.md
- docs/security/system-downtime-deployment.md
- docs/security/system-downtime-evidence.json

## Remaining launch risk

A backend/tool outage can be spoken safely only while Retell's conversation/audio service is running. If Retell is fully down, Apero cannot play an outage message. A disconnected/timeout write may already have committed; the patient is directed to the clinic for verification without a success or failure claim. Generic wording is necessary when trusted contact configuration is unavailable. Logs/response construction do not prove that audio reached the caller. Full telephony acceptance remains a launch dependency.
