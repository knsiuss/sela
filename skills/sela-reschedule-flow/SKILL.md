---
name: sela-reschedule-flow
description: Canonical reschedule conversation flow (deterministic buttons + free-text date input). Use for any book/reschedule/cancel dialogue.
---

# Reschedule Flow

1. Buttons for canonical actions (max 3 quick-reply or 2 CTA, label ≤20 chars): Lihat slot, Pilih slot, Konfirmasi, Batal, Bicara staf. Button tap = deterministic intent, no NLU needed.
2. Free text ONLY for date/time input + reason. Everything ambiguous → one clarification question + button options, never a guess.
3. Always re-confirm the slot in canonical form (day, date, time, timezone) via button before writing.
4. Link-fallback: when the channel cannot complete booking inline (e.g. SMS), send a booking link instead of failing.
5. After write: confirmation + "reply OPERATOR for staff" escape hatch on every message.
