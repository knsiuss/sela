---
name: sela-pms-writeback
description: SOP for writing booking mutations (hold, confirm, cancel) through the single-writer path. Use whenever an agent creates, moves, or cancels an appointment slot.
---

# PMS Writeback

1. Never write a slot from LLM output directly. Propose, then call the writer.
2. Flow: `hold_slot` (TTL 5-10 min, server-enforced) → explicit user confirmation via button → `confirm_hold` with idempotency key `{conversation_id}:{hold_id}`.
3. Re-check fresh availability inside the write transaction. Stale reads are the top double-book cause.
4. On retry, reuse the same idempotency key. Never invent a second hold for the same request.
5. Cancel path: release hold first, then mark cancelled, then offer the freed slot to the waitlist.
6. Log every transition (hold → confirm/cancel/expire) to the audit log with `conversation_id` and actor.
