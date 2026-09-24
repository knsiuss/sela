import { describe, expect, it } from "vitest";
import { build_fairness_plan, DEFAULT_FAIRNESS_POLICY } from "../src/fairness.js";
import { FCFS_POLICY_VERSION, FCFS_TIE_BREAK_RULE, type MatchedSlot } from "../src/types.js";

function make_slot(tenant_id: string, created_at: string, slot_id = "slot_1"): MatchedSlot {
  return {
    tenant_id,
    tenant_name: tenant_id,
    slot_id,
    start_time: "2026-09-28T08:00:00Z",
    end_time: "2026-09-28T08:30:00Z",
    created_at,
    vertical: "clinic",
    locale: "id-ID",
  };
}

describe("FCFS fairness", () => {
  it("orders earlier tenant availability first", () => {
    const plan = build_fairness_plan([
      make_slot("tenant_late", "2026-09-24T09:00:00Z"),
      make_slot("tenant_early", "2026-09-24T08:00:00Z"),
    ]);

    expect(plan.ordered_slots.map((slot) => slot.tenant_id)).toEqual([
      "tenant_early",
      "tenant_late",
    ]);
    expect(plan.policy_version).toBe(FCFS_POLICY_VERSION);
  });

  it("uses tenant id then slot id as a stable documented tie breaker", () => {
    const tied_slots = [
      make_slot("tenant_b", "2026-09-24T08:00:00Z", "slot_z"),
      make_slot("tenant_a", "2026-09-24T08:00:00Z", "slot_b"),
      make_slot("tenant_a", "2026-09-24T08:00:00Z", "slot_a"),
    ];

    const forward_plan = build_fairness_plan(tied_slots, DEFAULT_FAIRNESS_POLICY);
    const reverse_plan = build_fairness_plan([...tied_slots].reverse(), DEFAULT_FAIRNESS_POLICY);

    expect(forward_plan.ordered_slots.map((slot) => `${slot.tenant_id}:${slot.slot_id}`)).toEqual([
      "tenant_a:slot_a",
      "tenant_a:slot_b",
      "tenant_b:slot_z",
    ]);
    expect(reverse_plan.ordered_slots).toEqual(forward_plan.ordered_slots);
    expect(forward_plan.policy.tie_break_rule).toBe(FCFS_TIE_BREAK_RULE);
  });

  it("caps selected offers without treating capacity exclusions as bookings", () => {
    const plan = build_fairness_plan([
      make_slot("tenant_a", "2026-09-24T08:00:00Z", "slot_a"),
      make_slot("tenant_b", "2026-09-24T08:01:00Z", "slot_b"),
      make_slot("tenant_c", "2026-09-24T08:02:00Z", "slot_c"),
      make_slot("tenant_d", "2026-09-24T08:03:00Z", "slot_d"),
    ]);

    expect(plan.selected_slots).toHaveLength(3);
    expect(plan.excluded_slots).toHaveLength(1);
    expect(plan.selected_slots[0]?.tenant_id).toBe("tenant_a");
  });
});
