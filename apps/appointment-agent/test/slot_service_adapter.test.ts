import { describe, expect, it, vi } from "vitest";
import {
  SlotService,
  SlotUnavailableError as SlotEngineSlotUnavailableError,
  MAX_HOLD_TTL_SECONDS,
} from "@repo/slot-engine";
import { HoldExpiredError, SlotUnavailableError } from "../src/tools/calendar.js";
import { SlotServiceAdapter } from "../src/tools/slot_service_adapter.js";
import { resolve_hold_ttl_seconds } from "../src/tools/hold_ttl.js";
import type { TimeSlot } from "../src/state.js";

const TENANT_A = "tenant_a";
const TENANT_B = "tenant_b";
const PROVIDER_A = "provider_a";
const SLOT_ONE: TimeSlot = {
  id: "slot-1",
  start_iso: "2026-10-01T08:00:00Z",
  end_iso: "2026-10-01T08:30:00Z",
  staff: PROVIDER_A,
};
const SLOT_TWO: TimeSlot = {
  id: "slot-2",
  start_iso: "2026-10-01T09:00:00Z",
  end_iso: "2026-10-01T09:30:00Z",
  staff: PROVIDER_A,
};

interface TestClock {
  advance_ms: (delta_ms: number) => void;
  clock: () => number;
}

function make_clock(): TestClock {
  let now_ms = Date.parse("2026-10-01T07:00:00Z");
  return {
    advance_ms: (delta_ms: number) => {
      now_ms += delta_ms;
    },
    clock: () => now_ms,
  };
}

function make_adapter(
  service: SlotService,
  tenant_id: string,
  slots: TimeSlot[] = [SLOT_ONE],
): SlotServiceAdapter {
  return new SlotServiceAdapter({ tenant_id, service, slots });
}

describe("slot service adapter", () => {
  it("allows only one concurrent hold for the same slot", async () => {
    const test_clock = make_clock();
    const service = new SlotService({ clock: test_clock.clock });
    const adapter = make_adapter(service, TENANT_A);

    const results = await Promise.allSettled([
      adapter.hold_slot(SLOT_ONE.id, 300),
      adapter.hold_slot(SLOT_ONE.id, 300),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toBeDefined();
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toBeInstanceOf(SlotUnavailableError);
    }
  });

  it("replays the same live hold for a stable hold idempotency key", async () => {
    const adapter = make_adapter(new SlotService(), TENANT_A, [SLOT_ONE, SLOT_TWO]);
    const first = await adapter.hold_slot(SLOT_ONE.id, 300, "hold-retry-key");
    const replay = await adapter.hold_slot(SLOT_ONE.id, 300, "hold-retry-key");

    expect(replay).toEqual(first);
    await expect(adapter.hold_slot(SLOT_TWO.id, 300, "hold-retry-key")).rejects.toBeInstanceOf(
      SlotUnavailableError,
    );
  });

  it("returns the same appointment for an idempotent confirm retry", async () => {
    const test_clock = make_clock();
    const service = new SlotService({ clock: test_clock.clock });
    const confirm_spy = vi.spyOn(service, "confirm_hold");
    const adapter = make_adapter(service, TENANT_A);
    const hold = await adapter.hold_slot(SLOT_ONE.id, 300);

    await adapter.confirm_hold(hold.hold_id, "retry-key");
    await adapter.confirm_hold(hold.hold_id, "retry-key");

    expect(confirm_spy).toHaveBeenCalledTimes(2);
    expect(confirm_spy.mock.calls[0]).toEqual(confirm_spy.mock.calls[1]);
    expect(confirm_spy.mock.results[1]?.value).toEqual(confirm_spy.mock.results[0]?.value);
    expect(confirm_spy.mock.results[0]?.value).toMatchObject({ status: "confirmed" });
  });

  it("rejects a hold confirmation from another tenant", async () => {
    const test_clock = make_clock();
    const service = new SlotService({ clock: test_clock.clock });
    const tenant_a_adapter = make_adapter(service, TENANT_A);
    const tenant_b_adapter = make_adapter(service, TENANT_B);
    const hold = await tenant_a_adapter.hold_slot(SLOT_ONE.id, 300);

    await expect(tenant_b_adapter.confirm_hold(hold.hold_id, "foreign-key")).rejects.toBeInstanceOf(
      HoldExpiredError,
    );
  });

  it("does not release a hold owned by another tenant", async () => {
    const test_clock = make_clock();
    const service = new SlotService({ clock: test_clock.clock });
    const tenant_a_adapter = make_adapter(service, TENANT_A);
    const tenant_b_adapter = make_adapter(service, TENANT_B);
    const hold = await tenant_a_adapter.hold_slot(SLOT_ONE.id, 300);

    await tenant_b_adapter.release_hold(hold.hold_id);
    await expect(tenant_a_adapter.confirm_hold(hold.hold_id, "still-valid-key")).resolves.toBeUndefined();
  });

  it("makes a cancelled slot available again", async () => {
    const service = new SlotService();
    const adapter = make_adapter(service, TENANT_A);
    const hold = await adapter.hold_slot(SLOT_ONE.id, 300);
    await adapter.confirm_hold(hold.hold_id, "cancel-key");

    expect(await adapter.list_slots("2026-10-01T07:00:00Z", "2026-10-01T08:30:00Z")).toEqual([]);
    await adapter.cancel_booking(SLOT_ONE.id);
    expect(await adapter.list_slots("2026-10-01T07:00:00Z", "2026-10-01T08:30:00Z")).toEqual([SLOT_ONE]);
  });

  it("clamps the configured TTL to the package maximum and expires the hold", async () => {
    const test_clock = make_clock();
    const service = new SlotService({ clock: test_clock.clock });
    const adapter = make_adapter(service, TENANT_A);

    expect(resolve_hold_ttl_seconds({})).toBe(300);
    expect(resolve_hold_ttl_seconds({ HOLD_TTL_SECONDS: "999" })).toBe(MAX_HOLD_TTL_SECONDS);
    const hold = await adapter.hold_slot(SLOT_ONE.id, MAX_HOLD_TTL_SECONDS + 120);
    expect(Date.parse(hold.expires_at_iso)).toBe(
      Date.parse("2026-10-01T07:00:00Z") + MAX_HOLD_TTL_SECONDS * 1000,
    );

    test_clock.advance_ms((MAX_HOLD_TTL_SECONDS + 1) * 1000);
    await expect(adapter.confirm_hold(hold.hold_id, "expired-key")).rejects.toBeInstanceOf(HoldExpiredError);
  });

  it("rejects invalid TTL values instead of silently coercing them", async () => {
    const adapter = make_adapter(new SlotService(), TENANT_A);

    await expect(adapter.hold_slot(SLOT_ONE.id, 0)).rejects.toBeInstanceOf(RangeError);
    expect(() => resolve_hold_ttl_seconds({ HOLD_TTL_SECONDS: "not-a-number" })).toThrow(RangeError);
  });

  it("rejects an expired confirm even when the hold was created with a short TTL", async () => {
    const test_clock = make_clock();
    const service = new SlotService({ clock: test_clock.clock });
    const adapter = make_adapter(service, TENANT_A);
    const hold = await adapter.hold_slot(SLOT_ONE.id, 1);

    test_clock.advance_ms(1001);
    await expect(adapter.confirm_hold(hold.hold_id, "expired-short-key")).rejects.toBeInstanceOf(HoldExpiredError);
  });

  it("does not allow rescheduling onto an overlapping confirmed window", () => {
    const test_clock = make_clock();
    const service = new SlotService({ clock: test_clock.clock });
    const first_hold = service.hold_slot({
      tenant_id: TENANT_A,
      provider_id: PROVIDER_A,
      start_time: SLOT_ONE.start_iso,
      end_time: SLOT_ONE.end_iso,
    });
    const first = service.confirm_hold({
      hold_id: first_hold.hold_id,
      tenant_id: TENANT_A,
      idempotency_key: "first-key",
    });
    const second_hold = service.hold_slot({
      tenant_id: TENANT_A,
      provider_id: PROVIDER_A,
      start_time: SLOT_TWO.start_iso,
      end_time: SLOT_TWO.end_iso,
    });
    const second = service.confirm_hold({
      hold_id: second_hold.hold_id,
      tenant_id: TENANT_A,
      idempotency_key: "second-key",
    });

    expect(() =>
      service.reschedule({
        appointment_id: second.id,
        tenant_id: TENANT_A,
        new_start_time: SLOT_ONE.start_iso,
        new_end_time: SLOT_ONE.end_iso,
      }),
    ).toThrow(SlotEngineSlotUnavailableError);
    expect(service.get_appointment({ appointment_id: second.id, tenant_id: TENANT_A })?.start_time).toBe(
      SLOT_TWO.start_iso,
    );
    expect(service.get_appointment({ appointment_id: first.id, tenant_id: TENANT_A })?.start_time).toBe(
      SLOT_ONE.start_iso,
    );
  });

  it("maps a slot's staff identifier to the package provider and filters the requested window", async () => {
    const service = new SlotService();
    const adapter = make_adapter(service, TENANT_A, [SLOT_ONE, SLOT_TWO]);

    const listed = await adapter.list_slots("2026-10-01T07:00:00Z", "2026-10-01T09:00:00Z");
    expect(listed).toEqual([SLOT_ONE]);

    const hold = await adapter.hold_slot(SLOT_ONE.id, 300);
    expect(hold).toMatchObject({ slot_id: SLOT_ONE.id, hold_id: expect.any(String) });
    const appointment = service.confirm_hold({
      hold_id: hold.hold_id,
      tenant_id: TENANT_A,
      idempotency_key: "provider-key",
    });
    expect(appointment.provider_id).toBe(PROVIDER_A);
  });
});
