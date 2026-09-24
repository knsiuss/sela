# appointment-agent (MVP scaffold)

LangGraph TypeScript state machine for the Sela reschedule agent. It maps to
`docs/05-Execution/02-MVP-Scope.md`.

## Flow

`parse` (intent + handoff gates) → `offer` (three slots) → `hold` (timed
slot hold) → `confirm` (human-in-the-loop `interrupt` before the irreversible
write) → `write` (idempotent calendar write).

The app depends on `@repo/slot-engine` through `SlotServiceAdapter`. The adapter
maps app slots and holds to the package's tenant-scoped `SlotService` and
translates package errors at the boundary. `InMemoryCalendar` is a test helper
only and is not the runtime default.

The app TTL policy reads `HOLD_TTL_SECONDS`, defaults to 300 seconds, and
clamps requests to the package maximum of 600 seconds.

## Voice-note reschedule boundary

`src/voice_note_flow.ts` handles transcript text through
`handle_voice_note()`. A complete proposal emits the `@repo/voice-intent`
consent card and returns `await_confirmation`; it has no calendar dependency
and cannot hold or write a slot. Missing or conflicting date/time fields return
one clarification question, while `batal` returns the `cancel` route for the
existing cancellation flow. Speech-to-text, text-to-speech, audio upload, and
queue processing are deliberately outside this boundary. The local scaffold can
exercise the transcript path with `pnpm dev -- --voice-note "besok sore"`.

## Cross-tenant concierge pilot

`src/cross_tenant_search.ts` is a partial integration for a customer request such
as “cari slot minggu ini di klinik terdekat”. It calls the read-only
`@repo/slot-broker` search and returns consent-card offers only.

This path is intentionally concierge-grade, not an autonomous booking path:

- The handler requires an injected authorization decision; a non-`true` result
  fails closed before consent or provider work.
- `consent_granted !== true` returns an opt-in clarification without querying
  any partner tenant.
- A partner must have both sharing consent and an active partner contract; the
  requester tenant and vertical/locale mismatches are excluded with audit
  reasons.
- Fairness is deterministic FCFS by availability `created_at`, with documented
  `tenant_id` then `slot_id` tie-breaking and no LLM in the policy.
- Offers are not bookings. They remain `pending_human_approval`, and the normal
  calendar writer is not called by this node.

The CLI path uses an empty in-memory provider so a local run cannot broadcast
availability. A pilot deployment must inject a tenant-scoped, consented
provider, add provider timeouts/rate limits, authenticate the requester, and
connect a separately audited human approval and single-writer booking flow.
Production use remains blocked until those controls, partner agreements, and
privacy review are complete.

## Run

```bash
pnpm install
pnpm test
pnpm dev -- "I would like to reschedule to Thursday afternoon, can I?"
```

Set `TENANT_ID` for a non-default runtime tenant. The CLI uses a single
in-process package service for the local scaffold; production persistence and
calendar-provider integration are outside this cutover. Runtime slots use
opaque staff/provider ids; `resource` retains the display label.

The cross-tenant CLI path defaults to `CROSS_TENANT_CONSENT_GRANTED=false`
and `CROSS_TENANT_AUTHZ_GRANTED=false`, with an empty in-memory provider. The
latter is only a local scaffold switch; it is not production authentication.
`CROSS_TENANT_VERTICAL` and `CROSS_TENANT_LOCALE` may set the requested
dimensions, but no partner availability is loaded until an authenticated
conversation authorizes it and a consented provider is wired in code.

### Tests and typecheck

```bash
npx vitest run test/slot_service_adapter.test.ts test/slot_hold.test.ts
npx vitest run
npx tsc --noEmit
```
