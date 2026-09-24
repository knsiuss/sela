import { describe, expect, it, vi } from "vitest";
import { build_graph } from "../src/graph.js";
import type { AppointmentStateType } from "../src/state.js";
import type { CalendarPort } from "../src/tools/calendar.js";

function initial_state(overrides: Partial<AppointmentStateType> = {}): AppointmentStateType {
  return {
    conversation_id: "graph-test",
    raw_message: "mau geser jadwal",
    button_id: undefined,
    intent: "unknown",
    confidence: 0,
    candidate_slots: [],
    chosen_slot_id: undefined,
    hold: undefined,
    customer_confirmed: false,
    needs_human: false,
    human_summary: undefined,
    done: false,
    ...overrides,
  };
}

describe("appointment graph", () => {
  it("builds without colliding node names with state fields", async () => {
    const calendar = {
      list_slots: vi.fn(async () => [
        {
          id: "slot-1",
          start_iso: "2026-09-25T08:00:00.000Z",
          end_iso: "2026-09-25T09:00:00.000Z",
          staff: "provider-1",
        },
      ]),
      hold_slot: vi.fn(),
      confirm_hold: vi.fn(),
      release_hold: vi.fn(),
      cancel_booking: vi.fn(),
    } as unknown as CalendarPort;

    const result = await build_graph(calendar).invoke(initial_state());

    expect(result.intent).toBe("reschedule");
    expect(result.candidate_slots).toHaveLength(1);
    expect(result.done).toBe(true);
  });

  it("does not write or wait for staff when customer confirmation is absent", async () => {
    const confirm_hold = vi.fn();
    const calendar = {
      list_slots: vi.fn(async () => []),
      hold_slot: vi.fn(async () => ({
        hold_id: "hold-1",
        expires_at_iso: "2026-09-25T09:05:00.000Z",
      })),
      confirm_hold,
      release_hold: vi.fn(),
      cancel_booking: vi.fn(),
    } as unknown as CalendarPort;

    const result = await build_graph(calendar).invoke(
      initial_state({
        intent: "reschedule",
        confidence: 0.8,
        chosen_slot_id: "slot-1",
        customer_confirmed: false,
      }),
    );

    expect(result.done).toBe(true);
    expect(result.hold?.hold_id).toBe("hold-1");
    expect(confirm_hold).not.toHaveBeenCalled();
  });
});
