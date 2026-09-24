import { describe, expect, it } from "vitest";
import { build_outbound_drafts } from "../src/outbound/reply_builder.js";
import type { AppointmentStateType } from "../src/state.js";

function state(overrides: Partial<AppointmentStateType> = {}): AppointmentStateType {
  return {
    conversation_id: "reply-test",
    raw_message: "mau geser",
    button_id: undefined,
    intent: "reschedule",
    confidence: 0.8,
    candidate_slots: [],
    chosen_slot_id: undefined,
    hold: undefined,
    customer_confirmed: false,
    needs_human: false,
    human_summary: undefined,
    done: true,
    ...overrides,
  };
}

describe("reply builder", () => {
  it("offers selectable slots without claiming the appointment changed", () => {
    const drafts = build_outbound_drafts(
      state({
        candidate_slots: [
          { id: "slot-1", start_iso: "2026-09-25T08:00:00.000Z", end_iso: "2026-09-25T09:00:00.000Z" },
          { id: "slot-2", start_iso: "2026-09-25T10:00:00.000Z", end_iso: "2026-09-25T11:00:00.000Z" },
        ],
      }),
      "+15551234567",
    );

    expect(drafts[0]?.text).toContain("Available appointment times");
    expect(drafts[0]?.text).not.toContain("confirmed");
    expect(drafts[0]?.buttons).toHaveLength(3);
    expect(drafts[0]?.buttons?.map((button) => button.id)).toEqual([
      "pick_slot_1",
      "pick_slot_2",
      "change_day",
    ]);
  });

  it("requires an explicit customer confirmation for a held slot", () => {
    const drafts = build_outbound_drafts(
      state({
        hold: { hold_id: "hold-1", slot_id: "slot-1", expires_at_iso: "2099-01-01T00:00:00.000Z" },
        chosen_slot_id: "slot-1",
      }),
      "+15551234567",
    );

    expect(drafts[0]?.text).toContain("confirm");
    expect(drafts[0]?.text).not.toContain("Your appointment change is confirmed");
    expect(drafts[0]?.buttons?.map((button) => button.id)).toEqual([
      "confirm_move",
      "confirm_cancel",
    ]);
  });

  it("emits a confirmation only after the explicit state flag is true", () => {
    const drafts = build_outbound_drafts(
      state({
        hold: { hold_id: "hold-1", slot_id: "slot-1", expires_at_iso: "2099-01-01T00:00:00.000Z" },
        chosen_slot_id: "slot-1",
        customer_confirmed: true,
        done: true,
      }),
      "+15551234567",
    );

    expect(drafts[0]?.text).toBe("Your appointment change is confirmed.");
  });

  it("uses a handoff reply for deny-listed messages", () => {
    const drafts = build_outbound_drafts(
      state({ raw_message: "operator", needs_human: true, human_summary: "Escalated" }),
      "+15551234567",
    );

    expect(drafts[0]?.text).toContain("team");
    expect(drafts[0]?.buttons?.[0]?.id).toBe("operator");
  });
});
