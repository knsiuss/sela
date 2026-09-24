import { describe, expect, it, vi } from "vitest";
import type { AppointmentStateType, TimeSlot } from "../../src/state.js";
import {
  HoldExpiredError,
  SlotUnavailableError,
  type CalendarPort,
} from "../../src/tools/calendar.js";
import { InMemoryRescheduleSessionStore } from "../../src/reschedule/session_store.js";
import { RescheduleTurnProcessor } from "../../src/reschedule/turn_processor.js";
import type {
  GraphRunner,
  TurnProcessorInput,
} from "../../src/worker/process_job.js";

const PHONE = "+15551234567";
const NOW_ISO = "2026-09-24T08:00:00.000Z";
const HOLD_EXPIRES_ISO = "2026-09-24T08:05:00.000Z";
const SLOTS: TimeSlot[] = [
  { id: "slot-1", start_iso: "2026-10-01T08:00:00.000Z", end_iso: "2026-10-01T08:30:00.000Z" },
  { id: "slot-2", start_iso: "2026-10-01T09:00:00.000Z", end_iso: "2026-10-01T09:30:00.000Z" },
];

function make_calendar() {
  const hold_slot = vi.fn(async (slot_id: string) => ({
    hold_id: `hold-for-${slot_id}`,
    expires_at_iso: HOLD_EXPIRES_ISO,
  }));
  const confirm_hold = vi.fn(async () => undefined);
  const release_hold = vi.fn(async () => undefined);
  const cancel_booking = vi.fn(async () => undefined);
  const list_slots = vi.fn(async () => SLOTS);
  const calendar: CalendarPort = { list_slots, hold_slot, confirm_hold, release_hold, cancel_booking };
  return { calendar, hold_slot, confirm_hold, release_hold, cancel_booking, list_slots };
}

function offered_state(state: AppointmentStateType): AppointmentStateType {
  return {
    ...state,
    intent: "reschedule",
    confidence: 0.8,
    candidate_slots: SLOTS,
    done: true,
  };
}

function make_harness() {
  let now_ms = Date.parse(NOW_ISO);
  const session_store = new InMemoryRescheduleSessionStore({ clock: () => new Date(now_ms) });
  const calendar = make_calendar();
  const graph_runner: GraphRunner = { invoke: vi.fn(async (state) => offered_state(state)) };
  const create_processor = () => new RescheduleTurnProcessor({
    session_store,
    calendar: calendar.calendar,
    graph_runner,
    clock: () => new Date(now_ms),
  });
  return {
    session_store,
    ...calendar,
    graph_runner,
    create_processor,
    advance_ms: (milliseconds: number) => {
      now_ms += milliseconds;
    },
  };
}

function turn(overrides: Partial<TurnProcessorInput> = {}): TurnProcessorInput {
  const wamid = overrides.wamid ?? "wamid-1";
  return {
    tenant_id: "42",
    conversation_id: "conversation-1",
    wamid,
    reply_target: PHONE,
    message: {
      wamid,
      sender_ref: "opaque-sender-reference",
      text_body: "I would like to reschedule",
      message_kind: "text",
      sent_at_iso: NOW_ISO,
    },
    ...overrides,
  };
}

function button_turn(input: {
  wamid: string;
  button_id: string;
  tenant_id?: string;
  conversation_id?: string;
  text_body?: string;
}): TurnProcessorInput {
  return turn({
    tenant_id: input.tenant_id ?? "42",
    conversation_id: input.conversation_id ?? "conversation-1",
    wamid: input.wamid,
    message: {
      wamid: input.wamid,
      sender_ref: "opaque-sender-reference",
      text_body: input.text_body ?? "Quick reply",
      message_kind: "button_reply",
      button_id: input.button_id,
      sent_at_iso: NOW_ISO,
    },
  });
}

async function offer(processor: RescheduleTurnProcessor) {
  return processor.process(turn());
}

async function pick(processor: RescheduleTurnProcessor, wamid = "wamid-pick") {
  return processor.process(button_turn({ wamid, button_id: "pick_slot_1_g1" }));
}

describe("reschedule turn processor", () => {
  it("offers only generation-bound buttons and never holds on the first text turn", async () => {
    const harness = make_harness();
    const [draft] = await offer(harness.create_processor());

    expect(draft?.buttons?.map((button) => button.id)).toEqual([
      "pick_slot_1_g1",
      "pick_slot_2_g1",
      "change_day_g1",
    ]);
    expect(draft?.text).toContain("Available appointment times");
    expect(harness.hold_slot).not.toHaveBeenCalled();
    expect(harness.confirm_hold).not.toHaveBeenCalled();
    expect(harness.release_hold).not.toHaveBeenCalled();
    expect(harness.cancel_booking).not.toHaveBeenCalled();
    expect(harness.graph_runner.invoke).toHaveBeenCalledTimes(1);
    const session = await harness.session_store.load({ tenant_id: "42", conversation_id: "conversation-1" });
    expect(session).toMatchObject({ phase: "offered", offer_generation: 1, last_wamid: "wamid-1" });
    expect(JSON.stringify(session)).not.toContain("I would like to reschedule");
    expect(JSON.stringify(session)).not.toContain(PHONE);
  });

  it("holds a current pick with a stable key and returns exact reconfirm buttons", async () => {
    const harness = make_harness();
    await offer(harness.create_processor());
    const [draft] = await pick(harness.create_processor());

    expect(draft?.buttons?.map((button) => button.id)).toEqual([
      "confirm_move_g1",
      "confirm_cancel_g1",
    ]);
    expect(harness.hold_slot).toHaveBeenCalledWith(
      "slot-1",
      300,
      expect.stringMatching(/^reschedule-hold-v1:[a-f0-9]{64}$/),
    );
    expect((await harness.session_store.load({ tenant_id: "42", conversation_id: "conversation-1" })))
      .toMatchObject({ phase: "awaiting_confirmation", chosen_slot_id: "slot-1" });
  });

  it("rejects stale, unknown, and wrong-phase buttons without calendar mutation", async () => {
    const harness = make_harness();
    await offer(harness.create_processor());
    const processor = harness.create_processor();

    await processor.process(button_turn({ wamid: "wamid-stale", button_id: "pick_slot_1_g0" }));
    await processor.process(button_turn({ wamid: "wamid-unknown", button_id: "operator" }));
    await processor.process(button_turn({ wamid: "wamid-wrong-phase", button_id: "confirm_move_g1" }));

    expect(harness.hold_slot).not.toHaveBeenCalled();
    expect(harness.confirm_hold).not.toHaveBeenCalled();
    expect(harness.release_hold).not.toHaveBeenCalled();
    expect(harness.cancel_booking).not.toHaveBeenCalled();
  });

  it("re-offers safely when the selected slot is no longer available", async () => {
    const harness = make_harness();
    await offer(harness.create_processor());
    harness.hold_slot.mockRejectedValueOnce(new SlotUnavailableError("slot-1"));

    const [draft] = await harness.create_processor().process(
      button_turn({ wamid: "wamid-unavailable", button_id: "pick_slot_1_g1" }),
    );

    expect(draft?.buttons?.map((button) => button.id)).toEqual([
      "pick_slot_1_g2",
      "change_day_g2",
    ]);
    expect(harness.hold_slot).toHaveBeenCalledTimes(1);
    expect(harness.confirm_hold).not.toHaveBeenCalled();
  });

  it("re-offers safely when confirmation discovers an expired hold", async () => {
    const harness = make_harness();
    await offer(harness.create_processor());
    await pick(harness.create_processor());
    harness.confirm_hold.mockRejectedValueOnce(new HoldExpiredError("hold-for-slot-1"));

    const [draft] = await harness.create_processor().process(
      button_turn({ wamid: "wamid-expired-confirm", button_id: "confirm_move_g1" }),
    );

    expect(draft?.buttons?.map((button) => button.id)).toEqual([
      "pick_slot_1_g2",
      "pick_slot_2_g2",
      "change_day_g2",
    ]);
    expect(harness.confirm_hold).toHaveBeenCalledTimes(1);
    expect((await harness.session_store.load({ tenant_id: "42", conversation_id: "conversation-1" }))?.phase)
      .toBe("offered");
  });

  it("releases the hold before re-offering after a confirm conflict", async () => {
    const harness = make_harness();
    await offer(harness.create_processor());
    await pick(harness.create_processor());
    harness.confirm_hold.mockRejectedValueOnce(new SlotUnavailableError("slot-1"));

    const [draft] = await harness.create_processor().process(
      button_turn({ wamid: "wamid-confirm-conflict", button_id: "confirm_move_g1" }),
    );

    expect(draft?.buttons?.map((button) => button.id)).toEqual([
      "pick_slot_1_g2",
      "pick_slot_2_g2",
      "change_day_g2",
    ]);
    expect(harness.release_hold).toHaveBeenCalledWith("hold-for-slot-1");
    expect((await harness.session_store.load({ tenant_id: "42", conversation_id: "conversation-1" }))?.phase)
      .toBe("offered");
  });

  it("accepts the current change-day button as clarification without mutation", async () => {
    const harness = make_harness();
    await offer(harness.create_processor());
    const [draft] = await harness.create_processor().process(
      button_turn({ wamid: "wamid-change-day", button_id: "change_day_g1" }),
    );

    expect(draft?.text).toContain("another day");
    expect(draft).not.toHaveProperty("buttons");
    expect(harness.hold_slot).not.toHaveBeenCalled();
    expect((await harness.session_store.load({ tenant_id: "42", conversation_id: "conversation-1" })))
      .toMatchObject({ phase: "offered", offer_generation: 1 });
  });

  it("confirms only the current move button and writes exactly once", async () => {
    const harness = make_harness();
    await offer(harness.create_processor());
    await pick(harness.create_processor());
    const [draft] = await harness.create_processor().process(
      button_turn({ wamid: "wamid-confirm", button_id: "confirm_move_g1" }),
    );

    expect(draft?.text).toBe("Your appointment change is confirmed.");
    expect(draft).not.toHaveProperty("customer_confirmed");
    expect(draft).not.toHaveProperty("is_state_changing");
    expect(harness.confirm_hold).toHaveBeenCalledTimes(1);
    expect(harness.confirm_hold).toHaveBeenCalledWith(
      "hold-for-slot-1",
      expect.stringMatching(/^reschedule-confirm-v1:[a-f0-9]{64}$/),
    );
    expect((await harness.session_store.load({ tenant_id: "42", conversation_id: "conversation-1" }))?.phase)
      .toBe("confirmed");
  });

  it("replays a duplicate confirmation without another calendar write", async () => {
    const harness = make_harness();
    await offer(harness.create_processor());
    await pick(harness.create_processor());
    const duplicate = button_turn({ wamid: "wamid-confirm", button_id: "confirm_move_g1" });
    await harness.create_processor().process(duplicate);
    const [replay] = await harness.create_processor().process(duplicate);

    expect(replay?.text).toBe("Your appointment change is confirmed.");
    expect(harness.confirm_hold).toHaveBeenCalledTimes(1);
  });

  it("releases only the current held slot on confirm_cancel", async () => {
    const harness = make_harness();
    await offer(harness.create_processor());
    await pick(harness.create_processor());
    const [draft] = await harness.create_processor().process(
      button_turn({ wamid: "wamid-cancel", button_id: "confirm_cancel_g1" }),
    );

    expect(draft?.text).toContain("released");
    expect(harness.release_hold).toHaveBeenCalledTimes(1);
    expect(harness.confirm_hold).not.toHaveBeenCalled();
    expect(harness.cancel_booking).not.toHaveBeenCalled();
    expect((await harness.session_store.load({ tenant_id: "42", conversation_id: "conversation-1" }))?.phase)
      .toBe("cancelled");
  });

  it("routes confirmed cancellation to handoff without cancel_booking", async () => {
    const harness = make_harness();
    await offer(harness.create_processor());
    await pick(harness.create_processor());
    await harness.create_processor().process(
      button_turn({ wamid: "wamid-confirm", button_id: "confirm_move_g1" }),
    );
    const [draft] = await harness.create_processor().process(
      button_turn({ wamid: "wamid-cancel-confirmed", button_id: "confirm_cancel_g1" }),
    );

    expect(draft?.text).toContain("team");
    expect(harness.cancel_booking).not.toHaveBeenCalled();
    expect(harness.release_hold).not.toHaveBeenCalled();
    expect((await harness.session_store.load({ tenant_id: "42", conversation_id: "conversation-1" }))?.phase)
      .toBe("handoff");
  });

  it("shares one session and calendar across separately constructed job processors", async () => {
    const harness = make_harness();
    await offer(harness.create_processor());
    await pick(harness.create_processor(), "wamid-pick");
    const [draft] = await harness.create_processor().process(
      button_turn({ wamid: "wamid-confirm", button_id: "confirm_move_g1" }),
    );

    expect(draft?.text).toBe("Your appointment change is confirmed.");
    expect(harness.hold_slot).toHaveBeenCalledTimes(1);
    expect(harness.confirm_hold).toHaveBeenCalledTimes(1);
  });

  it("releases the losing hold when concurrent picks conflict on one session version", async () => {
    const harness = make_harness();
    await offer(harness.create_processor());
    const results = await Promise.allSettled([
      harness.create_processor().process(
        button_turn({ wamid: "wamid-pick-one", button_id: "pick_slot_1_g1" }),
      ),
      harness.create_processor().process(
        button_turn({ wamid: "wamid-pick-two", button_id: "pick_slot_2_g1" }),
      ),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const session = await harness.session_store.load({ tenant_id: "42", conversation_id: "conversation-1" });
    expect(session).toMatchObject({ phase: "awaiting_confirmation" });
    expect(harness.hold_slot).toHaveBeenCalledTimes(2);
    expect(harness.release_hold).toHaveBeenCalledTimes(1);
    expect(harness.release_hold).not.toHaveBeenCalledWith(session?.hold_id);
  });

  it("keeps identical conversation ids isolated by tenant", async () => {
    const harness = make_harness();
    await offer(harness.create_processor());
    await pick(harness.create_processor());
    const tenant_b_turn = button_turn({
      tenant_id: "43",
      wamid: "wamid-tenant-b",
      button_id: "pick_slot_1_g1",
    });
    const [rejected] = await harness.create_processor().process(tenant_b_turn);

    expect(rejected?.text).toContain("no longer available");
    expect(harness.hold_slot).toHaveBeenCalledTimes(1);
    await expect(
      harness.session_store.load({ tenant_id: "43", conversation_id: "conversation-1" }),
    ).resolves.toBeNull();
  });

  it("never confirms from free-text yes while a hold awaits confirmation", async () => {
    const harness = make_harness();
    await offer(harness.create_processor());
    await pick(harness.create_processor());
    const [draft] = await harness.create_processor().process(turn({ wamid: "wamid-yes" }));

    expect(draft?.text).toContain("confirm");
    expect(draft?.buttons?.map((button) => button.id)).toEqual([
      "confirm_move_g1",
      "confirm_cancel_g1",
    ]);
    expect(harness.confirm_hold).not.toHaveBeenCalled();
  });

  it("moves an expired hold to a new safe offer generation without another hold", async () => {
    const harness = make_harness();
    await offer(harness.create_processor());
    await pick(harness.create_processor());
    harness.advance_ms(5 * 60 * 1000 + 1);
    const [draft] = await harness.create_processor().process(
      button_turn({ wamid: "wamid-after-expiry", button_id: "confirm_move_g1" }),
    );

    expect(draft?.buttons?.map((button) => button.id)).toEqual([
      "pick_slot_1_g2",
      "pick_slot_2_g2",
      "change_day_g2",
    ]);
    expect(harness.hold_slot).toHaveBeenCalledTimes(1);
    expect(harness.confirm_hold).not.toHaveBeenCalled();
    const session = await harness.session_store.load({ tenant_id: "42", conversation_id: "conversation-1" });
    expect(session).toMatchObject({ phase: "offered", offer_generation: 2, hold_id: null });
  });

  it("keeps a handoff terminal beyond the ordinary service window", async () => {
    const harness = make_harness();
    await offer(harness.create_processor());
    await harness.create_processor().process(button_turn({
      wamid: "wamid-operator",
      button_id: "pick_slot_1_g1",
      text_body: "operator please",
    }));
    harness.advance_ms(25 * 60 * 60 * 1000);

    const [draft] = await harness.create_processor().process(turn({ wamid: "wamid-after-handoff" }));

    expect(draft?.text).toContain("team");
    expect(harness.hold_slot).not.toHaveBeenCalled();
    expect((await harness.session_store.load({ tenant_id: "42", conversation_id: "conversation-1" }))?.phase)
      .toBe("handoff");
  });

  it("releases a live hold when handoff interrupts the flow", async () => {
    const harness = make_harness();
    await offer(harness.create_processor());
    await pick(harness.create_processor());

    const [draft] = await harness.create_processor().process(turn({
      wamid: "wamid-handoff-after-pick",
      message: {
        wamid: "wamid-handoff-after-pick",
        sender_ref: "opaque-sender-reference",
        text_body: "operator please",
        message_kind: "text",
        sent_at_iso: NOW_ISO,
      },
    }));

    expect(draft?.text).toContain("team");
    expect(harness.release_hold).toHaveBeenCalledWith("hold-for-slot-1");
    expect((await harness.session_store.load({ tenant_id: "42", conversation_id: "conversation-1" }))?.phase)
      .toBe("handoff");
  });

  it("persists terminal handoff before interpreting a button action", async () => {
    const harness = make_harness();
    await offer(harness.create_processor());
    const [draft] = await harness.create_processor().process(button_turn({
      wamid: "wamid-operator",
      button_id: "pick_slot_1_g1",
      text_body: "operator please",
    }));

    expect(draft?.text).toContain("team");
    expect(harness.hold_slot).not.toHaveBeenCalled();
    expect((await harness.session_store.load({ tenant_id: "42", conversation_id: "conversation-1" }))?.phase)
      .toBe("handoff");
  });
});
