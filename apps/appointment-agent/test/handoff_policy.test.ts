import { describe, expect, it } from "vitest";
import { detect_handoff_reason, mask_phone_digits, build_handoff_package, build_operator_reply, OPERATOR_KEYWORD } from "../src/handoff.js";
import { needs_human } from "../src/guardrails.js";
import type { AppointmentStateType } from "../src/state.js";

function state_with(message: string, overrides: Partial<AppointmentStateType> = {}): AppointmentStateType {
  return {
    conversation_id: "conv-1",
    raw_message: message,
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

describe("single handoff policy source", () => {
  it("test_operator_keyword_escalates_through_both_entry_points", () => {
    const message = "operator please";
    expect(detect_handoff_reason(message)).toBe("operator_keyword");
    const decision = needs_human(
      state_with(message, { intent: "reschedule", confidence: 0.8 }),
    );
    expect(decision).toEqual({ escalate: true, reason: "operator_keyword" });
  });

  it("test_emergency_outranks_clear_reschedule_intent", () => {
    const message = "mau geser besok, Dada saya sakit banget dan sesak";
    const decision = needs_human(state_with(message, { intent: "reschedule", confidence: 0.9 }));
    expect(decision.escalate).toBe(true);
    expect(decision.reason).toBe("emergency");
  });

  it("test_billing_dispute_escalates", () => {
    const decision = needs_human(state_with("saya mau refund", { intent: "cancel", confidence: 0.85 }));
    expect(decision.reason).toBe("billing");
  });

  it("test_explicit_human_request_escalates", () => {
    const decision = needs_human(state_with("tolong sambungkan ke dokter", { intent: "book", confidence: 0.75 }));
    expect(decision.reason).toBe("explicit_human");
  });

  it("test_low_confidence_gate_still_applies_without_deny_list_match", () => {
    const decision = needs_human(state_with("hmm gimana ya", { intent: "unknown", confidence: 0.3 }));
    expect(decision.escalate).toBe(true);
    expect(decision.reason).toBe("low-confidence:0.3");
  });

  it("test_clear_reschedule_passes_without_escalation", () => {
    const decision = needs_human(
      state_with("mau geser ke kamis sore bisa?", { intent: "reschedule", confidence: 0.8 }),
    );
    expect(decision.escalate).toBe(false);
  });
});

describe("handoff package", () => {
  it("test_mask_phone_digits_redacts_long_digit_runs_including_years", () => {
    // The mask is deliberately coarse: any 4+ digit run is replaced, so a
    // year is masked too. Losing the year is acceptable; leaking a phone
    // number into a persisted checkpointer is not.
    expect(mask_phone_digits("booking 25 Sep 2026, call 081234567890")).toBe(
      "booking 25 Sep [redacted-number], call [redacted-number]",
    );
    expect(mask_phone_digits("slot 15.30 on 25/9")).toBe("slot 15.30 on 25/9");
  });

  it("test_build_handoff_package_rejects_empty_ids", () => {
    expect(() =>
      build_handoff_package({
        conversation_id: "",
        reason: "operator_keyword",
        transcript: [],
        request_id: "req-1",
      }),
    ).toThrow(/invalid-handoff-request/);
  });

  it("test_build_operator_reply_is_non_empty", () => {
    expect(build_operator_reply().length).toBeGreaterThan(0);
    expect(OPERATOR_KEYWORD).toBe("operator");
  });
});
