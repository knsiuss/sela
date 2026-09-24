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

### Tests and typecheck

```bash
npx vitest run test/slot_service_adapter.test.ts test/slot_hold.test.ts
npx vitest run
npx tsc --noEmit
```
