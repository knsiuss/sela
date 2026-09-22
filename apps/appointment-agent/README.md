# appointment-agent (MVP scaffold)

LangGraph TypeScript state machine untuk reschedule agent. Maps to `docs/05-Execution/02-MVP-Scope.md`.

## Flow

`parse` (intent + D-05 handoff gates) → `offer` (3 slot) → `hold` (slot-hold berwaktu)
→ `confirm` (human-in-the-loop `interrupt` sebelum tulis irreversibel) → `write` (idempotent calendar write)

Satu `CalendarPort` memiliki semua mutasi slot. MVP memakai `InMemoryCalendar`; adaptor Google Calendar menggantikannya tanpa mengubah graph.

## Run

```bash
npm install
npm test
npm run dev -- "mau geser ke kamis sore bisa?"
```
