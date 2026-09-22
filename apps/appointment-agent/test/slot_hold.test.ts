import { describe, expect, it } from "vitest";
import { HoldExpiredError, InMemoryCalendar, SlotUnavailableError } from "../src/tools/calendar.js";
import { classify_intent, needs_human } from "../src/guardrails.js";
import type { AppointmentStateType } from "../src/state.js";

function base_state(overrides: Partial<AppointmentStateType> = {}): AppointmentStateType {
  return {
    conversation_id: "test-1",
    raw_message: "",
    intent: "unknown",
    confidence: 0,
    candidate_slots: [],
    chosen_slot_id: undefined,
    hold: undefined,
    needs_human: false,
    human_summary: undefined,
    done: false,
    ...overrides,
  };
}

describe("guardrails", () => {
  it("test_needs_human_escalates_low_confidence_message", () => {
    const gate = needs_human(base_state({ raw_message: "hmm gimana ya", confidence: 0.3 }));
    expect(gate.escalate).toBe(true);
  });

  it("test_needs_human_escalates_liability_keyword_despite_clear_intent", () => {
    const message = "mau refund karena salah tagih";
    const { intent, confidence } = classify_intent(message);
    const gate = needs_human(base_state({ raw_message: message, intent, confidence }));
    expect(gate.escalate).toBe(true);
  });

  it("test_needs_human_passes_clear_reschedule_request", () => {
    const message = "mau geser ke kamis sore bisa?";
    const { intent, confidence } = classify_intent(message);
    expect(intent).toBe("reschedule");
    const gate = needs_human(base_state({ raw_message: message, intent, confidence }));
    expect(gate.escalate).toBe(false);
  });
});

describe("calendar writer", () => {
  it("test_hold_slot_rejects_double_booking", async () => {
    const calendar = new InMemoryCalendar([
      { id: "slot-1", start_iso: "2026-10-01T08:00:00Z", end_iso: "2026-10-01T08:30:00Z" },
    ]);
    const first = await calendar.hold_slot("slot-1", 300);
    await expect(calendar.hold_slot("slot-1", 300)).rejects.toThrow(SlotUnavailableError);
    await calendar.confirm_hold(first.hold_id, "idempotency-key-1");
    await expect(calendar.hold_slot("slot-1", 300)).rejects.toThrow(SlotUnavailableError);
  });

  it("test_confirm_hold_rejects_expired_hold", async () => {
    const calendar = new InMemoryCalendar([
      { id: "slot-1", start_iso: "2026-10-01T08:00:00Z", end_iso: "2026-10-01T08:30:00Z" },
    ]);
    const first = await calendar.hold_slot("slot-1", 0);
    await expect(calendar.confirm_hold(first.hold_id, "key")).rejects.toThrow(HoldExpiredError);
  });
});
