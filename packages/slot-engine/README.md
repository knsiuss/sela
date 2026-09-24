# @repo/slot-engine

Pure slot ranking and timed-hold helpers shared by appointment apps.

## Status

The `apps/appointment-agent` cutover is complete. The app now depends on this
package through `SlotServiceAdapter`; its old runtime `InMemoryCalendar`
prototype is retained only as a test helper. The package remains the source of
truth for tenant-scoped availability, holds, confirmation, and rescheduling.

The package default is 600 seconds. The app policy resolves `HOLD_TTL_SECONDS`
from the environment with a 300-second default and caps requests at the
package maximum of 600 seconds.

## Adapter mapping

- App `TimeSlot` windows map to package provider/window requests; `staff` is the
  provider identifier, with `resource` and a legacy default as fallbacks.
- App `SlotHold.expires_at_iso` maps to package `Hold.expires_at`.
- Package slot and hold errors are translated into the app's domain errors.
- `release_hold` and `cancel_booking` expose the package operations needed by
  the existing `CalendarPort` contract.

## Layout

- `src/slot_types.ts` — zod schemas, slot-key builder, TTL constants.
- `src/hold_store.ts` — in-memory TTL hold store (Redis later).
- `src/slot_service.ts` — availability, hold, confirm, release, reschedule,
  and cancellation operations.
- `src/index.ts` — public API re-exports.
- `tests/slot_service.test.ts` — domain tests.
- `tsconfig.json` — package compiler options.
