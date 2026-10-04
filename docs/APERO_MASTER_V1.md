# Apero Master Clinic Template v1

The separate Retell draft is compiled from the owner-supplied export,
`Retell Dental Clinic Arabic (Dr.Kandil) v2.json`. On 2026-10-04, recording
security and failed-booking fallback in `retell/master/reference/golden.json`
were reviewed: signed URLs expire after five minutes, failed bookings cannot
confirm, and a result-clearing node prevents an earlier success from surviving
a later tool timeout. Its reviewed SHA-256 is
`fa6885849dbdf9937d3189f7e57d38c44b08e2dbede4a2593a0b039835e7e97a`. The original export hash in `DEPLOYMENT.json` remains historical evidence.
That reference is a test/source artifact, **not the master to import**.

## What is reusable

`retell/master/build.py` compiles the existing 53-node, ten-tool receptionist plus one booking-result safety node.
Provider/service resolution, checked slots, confirmations, correction paths,
rescheduling, cancellation, persistence, interruptions and analysis fields come
from the golden export. Only approved clinic text/settings and the narrowly
documented regression repairs differ. No per-clinic copy of the source graph is
needed. Existing Dental Zone artifacts and its production agent are untouched.

Baseline: GPT-4.1, temperature 0, strict tools, agent starts, responsiveness 0.96,
fast STT, voice speed/volume/temperature 1, silence 179,000 ms, max duration
1,845,000 ms, and original post-call fields/model. Clinic-specific analysis
examples are removed. The original custom voice is available to the new master
in the same workspace; availability in another workspace must be checked.

### Regression repairs in the separate master

Real Retell text simulations exposed gaps in the inherited graph. The master:

- Routes mid-task messages through the existing message persistence path.
- Recognizes explicit callback requests globally, including after no slots.
- Invalidates and resolves a changed service during provider/date collection.
- Routes service-resolver technical errors to tool failure, not service ambiguity.
- Ends when callers explicitly finish, including after declining cancellation.
- Reinforces caller/patient separation, one question per turn, correct exact-time
  parameters, year preservation and immediate emergency advice.

These changes do not add tools or nodes and were never applied to Dental Zone.
`tests/test_master.py` checks all other node contents/edges and tool contracts
against the pinned, reviewed golden reference. Conversation simulations exercise behavior;
structural equality alone is not claimed as behavioral parity.

## Configuration and onboarding ownership

The machine-readable onboarding schema is `retell/master/config.schema.json`.
Every field is used or explicitly identified as deployment metadata. Start from
`retell/master/config/template.json`, not Dental Zone's old config.

| Owner | Information collected / source |
| --- | --- |
| Backend | Existing clinic UUID, name, phone, IANA timezone; active staff, services, aliases, weekly availability and time off. `prepare.py` reads and validates these. Never embed provider/service lists in prompts. |
| Retell | Agent display name, receptionist name in English/Arabic, default/supported Arabic/English language, spoken dialect, approved voice ID and greeting. |
| Shared approved facts | Clinic type, localized name, one address, public opening hours, pricing and insurance policies, FAQs, fallback phone, callback availability, urgent callback behavior and emergency guidance. |
| Server deployment | Distinct workspace, agent and flow IDs; shared tool/webhook URLs; unique Edge secret **name**, dialing prefix, local phone length, slot duration, optional inbound number. |
| Onboarding approval | `knowledge.approved_by`: who approved factual content/revision. Not spoken to callers. |
| Runtime only | System time/calendar, call ID, canonical service/provider IDs, checked slot tokens, patient/caller details and tool outcomes. Never collect these as clinic setup inputs. |

`mode=clinic` requires an existing clinic, its phone, approved facts ownership,
workspace, secret name and explicit dialing/slot settings. Empty FAQ/KB is valid:
the agent then acknowledges unknown facts and offers follow-up. Unknown address
or hours remain null; do not fabricate them to pass onboarding. All supported
fields are in the schema; additional properties (including API keys) are rejected.

## Approved knowledge

The exact golden export has **no attached KB**. Some facts were in its prompt and
default variables; no complete factual source for parking/payments was established.
The live Dental Zone flow separately retains its older KB; it was not inherited.

For launch, put approved answers in `knowledge.approved_faq`, and approved policies,
address/hours/phone in their config fields. These are compiled into the prompt.
An optional clinic-owned Retell KB can provide longer content. List only approved
KB IDs from that clinic's workspace; `prepare.py --create-draft` verifies access.
No pricing, insurance, parking or policy inference is allowed when facts are absent.
Backend tool results alone establish scheduling facts.

## Timezone and language

The generated agent explicitly sets `timezone` from `clinics.timezone`. Its prompt
uses Retell's documented `{{current_time}}`, `{{current_calendar}}` and
`{{system_timezone}}`; no timezone is embedded in a variable name. The template
uses UTC until instantiated. The backend still validates dates in its authoritative
clinic timezone and rejects past/stale slots. Changes to the backend timezone
require regenerating the clinic agent settings.

Retell supports default variables in prompts and static greetings; identity
defaults live in `flow.default_dynamic_variables`. Facts/policies are compiled
from trusted developer configuration. Never let an untrusted inbound caller or
public widget override clinic identity, policies or `system_timezone`. Runtime
dynamic variables never select the backend tenant.

Official references: [dynamic variables and timezone](https://docs.retellai.com/build/dynamic-variables),
[simulation testing and tool mocks](https://docs.retellai.com/test/llm-simulation-testing).

## Tenant boundary and secret handling

Each real clinic requires its own Retell workspace/key. The unbound template may
be stored beside the reference agent, but is not a second clinic integration.
Its requests fail closed until a distinct real clinic instance is registered.

`voice_integrations` is server-only, RLS enabled, with no anon/authenticated table
grants. It stores a secret's environment-variable name, never the secret value.
Workspace, agent and secret names are unique; the resolver also rejects two active
clinics with the same actual key value under different names. Secrets remain in
Supabase Edge secrets; no new Vault dependency or frontend access is introduced.

The claimed `call.agent_id` is only a lookup hint. The resolver verifies the raw
body with that mapping's server secret before trusting its `clinic_id`. Payload
`clinic_id` is ignored. All ten tools use `clinic-operations`. Checked slot tokens
and database records bind clinic, provider, call and check IDs. The webhook checks
call ownership and clinic-scopes patients, operations and appointment links.

## Scope

One operational location per clinic. The agent cannot promise location-specific
scheduling across branches. Live transfer is disabled and the schema rejects
enabling it without implementation; messages, callbacks and urgent requests persist
through the existing tools. An approved fallback phone is used when persistence
fails. No emergency response time is promised.

This implementation creates a voice receptionist. It does not add a WhatsApp
transport/integration. Real audio, phone routing and each clinic's voice/knowledge
need acceptance testing before public activation. Text simulations do not prove
audio interruption timing, pronunciation or telephony performance.

## Local verification

```bash
python3 -m pip install -r retell/master/requirements.txt
python3 -m unittest discover -s retell/master/tests -v
python3 -m unittest retell/test_flow.py -v
node retell/master/tests/edge-isolation.test.mjs
python3 retell/master/prepare.py --config retell/master/config/clinic-b.local.json --fixture retell/master/config/clinic-b.fixture.json --output-dir /tmp/clinic-b
npm run build
npx tsc --noEmit
npm run lint
git diff --check
```

The Edge tests execute actual handler/resolver/token code with a local database
adapter and signed synthetic requests. They are not a substitute for database RLS
tests. `tests/tenant_isolation.sql` tests the actual appointment RPC with random
synthetic clinics inside a rollback-only transaction; run the **whole file** on a
write-capable test database. The current management access rejected these writes
with `cannot execute INSERT in a read-only transaction`; no fixture was persisted.

`tests/scenarios.py` generates 45 Retell text cases. Every external tool has a
nonempty catch-all mock; unmatched tools must never run against production in
tests. Test records and final outcome details are recorded in the deployment record.

Export them with `python3 retell/master/simulate.py --output-dir /tmp/master-tests`.
To explicitly run paid, mocked text simulations against the separate master,
add `--submit --agent-id agent_8321fe512d2a71fa6642220c7f` with its workspace key
in `RETELL_API_KEY`. The runner refuses published/non-master agents and records
created test/batch IDs. Review transcripts in Retell's Simulation tab.

## Verification record — 2026-09-27

See `retell/master/DEPLOYMENT.json` for IDs, per-scenario results and limitations.
The final complete 45-case run had 43 passes, one failure and one simulator-loop
error. Both remaining cases used unrealistic retry mocks that kept offering the
same failed slot. After changing those test callers to request a distinct 11 AM
slot (with a matching mock), both passed on the **same final master flow**. Thus
all 45 scenarios have a passing final result across the full run and two-case
recheck; no claim is made that every stochastic run always passes.

Local verification: 13 master tests, seven historical flow tests and 26 Node tests
passed. Six non-destructive signed live probes passed. Production Dental Zone
agent/flow snapshots are identical before/after. The generated master exactly
matches its stored Retell flow. Build/type checking passed. Lint has the unchanged
baseline of 1,167 errors and nine warnings, with zero new findings.

### Failed-booking fallback

Creation failures return an explicit unconfirmed result and save an Open message
in the existing clinic Requests queue. The flow distinguishes saved follow-up
from storage failure, disables tool retries, and requires a fresh caller request,
availability check and read-back consent before another attempt. See
[failed-booking-fallback.md](security/failed-booking-fallback.md) for limits,
permissions, tests and rollout requirements. No notification subsystem is added.
