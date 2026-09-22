# @repo/slot-engine

Pure slot ranking and timed-hold helpers shared by appointment apps.

## Status

Implemented: tenant-scoped TTL slot holds plus check/hold/confirm with
idempotent writes. `apps/appointment-agent` keeps its own prototype for
now; cutover to this package is a separate task.

## Layout

- `src/slot_types.ts` — zod schemas, slot-key builder, TTL constants.
- `src/hold_store.ts` — in-memory TTL hold store (Redis later).
- `src/slot_service.ts` — availability, hold, confirm, reschedule.
- `src/index.ts` — public API re-exports.
- `tests/slot_service.test.ts` — domain tests.
- `tsconfig.json` — package compiler options.
