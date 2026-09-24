import { beforeEach, describe, expect, it } from "vitest";
import {
  AppointmentNotFoundError,
  HoldExpiredError,
  SlotService,
  SlotUnavailableError,
} from "../src/slot_service.js";

const TENANT_ID = "tenant_acme";
const PROVIDER_ID = "provider_dr_lee";
const WINDOW_ONE = { start_time: "2026-10-01T08:00:00Z", end_time: "2026-10-01T08:30:00Z" };
const WINDOW_TWO = { start_time: "2026-10-01T09:00:00Z", end_time: "2026-10-01T09:30:00Z" };

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

describe("slot service", () => {
  let test_clock: TestClock;
  let service: SlotService;

  beforeEach(() => {
    test_clock = make_clock();
    service = new SlotService({ clock: test_clock.clock });
  });

  it("test_hold_hides_slot_and_confirm_writes_appointment", () => {
    const hold = service.hold_slot({ tenant_id: TENANT_ID, provider_id: PROVIDER_ID, ...WINDOW_ONE });
    expect(hold.hold_id.startsWith("hold_")).toBe(true);
    expect(service.check_availability({ tenant_id: TENANT_ID, provider_id: PROVIDER_ID, ...WINDOW_ONE })).toBe(
      false,
    );
    const appointment = service.confirm_hold({
      hold_id: hold.hold_id,
      tenant_id: TENANT_ID,
      idempotency_key: "key-1",
    });
    expect(appointment.status).toBe("confirmed");
    expect(appointment.created_at).toBeTruthy();
    expect(appointment.updated_at).toBeTruthy();
    expect(service.check_availability({ tenant_id: TENANT_ID, provider_id: PROVIDER_ID, ...WINDOW_ONE })).toBe(
      false,
    );
  });

  it("test_reschedule_raises_error_when_slot_is_taken", () => {
    const first = service.hold_slot({ tenant_id: TENANT_ID, provider_id: PROVIDER_ID, ...WINDOW_ONE });
    service.confirm_hold({ hold_id: first.hold_id, tenant_id: TENANT_ID, idempotency_key: "key-first" });
    const second = service.hold_slot({ tenant_id: TENANT_ID, provider_id: PROVIDER_ID, ...WINDOW_TWO });
    const moving = service.confirm_hold({
      hold_id: second.hold_id,
      tenant_id: TENANT_ID,
      idempotency_key: "key-second",
    });
    expect(() =>
      service.reschedule({
        appointment_id: moving.id,
        tenant_id: TENANT_ID,
        new_start_time: WINDOW_ONE.start_time,
        new_end_time: WINDOW_ONE.end_time,
      }),
    ).toThrow(SlotUnavailableError);
    const unchanged = service.get_appointment({ appointment_id: moving.id, tenant_id: TENANT_ID });
    expect(unchanged?.start_time).toBe(WINDOW_TWO.start_time);
  });

  it("test_hold_expires_after_ttl", () => {
    const hold = service.hold_slot({ tenant_id: TENANT_ID, provider_id: PROVIDER_ID, ...WINDOW_ONE });
    test_clock.advance_ms(601 * 1000);
    expect(service.check_availability({ tenant_id: TENANT_ID, provider_id: PROVIDER_ID, ...WINDOW_ONE })).toBe(
      true,
    );
    expect(() =>
      service.confirm_hold({ hold_id: hold.hold_id, tenant_id: TENANT_ID, idempotency_key: "key-late" }),
    ).toThrow(HoldExpiredError);
    const retry = service.hold_slot({ tenant_id: TENANT_ID, provider_id: PROVIDER_ID, ...WINDOW_ONE });
    expect(retry.hold_id).not.toBe(hold.hold_id);
  });

  it("test_idempotent_write_returns_same_id_on_retry", () => {
    const hold = service.hold_slot({ tenant_id: TENANT_ID, provider_id: PROVIDER_ID, ...WINDOW_ONE });
    const first = service.confirm_hold({
      hold_id: hold.hold_id,
      tenant_id: TENANT_ID,
      idempotency_key: "retry-key",
    });
    const second = service.confirm_hold({
      hold_id: hold.hold_id,
      tenant_id: TENANT_ID,
      idempotency_key: "retry-key",
    });
    expect(second.id).toBe(first.id);
    expect(second.created_at).toBe(first.created_at);
  });

  it("test_confirm_hold_fails_closed_on_unknown_hold", () => {
    expect(() =>
      service.confirm_hold({ hold_id: "hold_missing", tenant_id: TENANT_ID, idempotency_key: "key-x" }),
    ).toThrow(HoldExpiredError);
  });

  it("test_reschedule_rejects_missing_appointment", () => {
    expect(() =>
      service.reschedule({
        appointment_id: "appt_missing",
        tenant_id: TENANT_ID,
        new_start_time: WINDOW_TWO.start_time,
        new_end_time: WINDOW_TWO.end_time,
      }),
    ).toThrow(AppointmentNotFoundError);
  });

  it("test_release_hold_is_tenant_scoped_and_idempotent", () => {
    const hold = service.hold_slot({ tenant_id: TENANT_ID, provider_id: PROVIDER_ID, ...WINDOW_ONE });

    expect(service.release_hold({ hold_id: hold.hold_id, tenant_id: "tenant_other" })).toBe(false);
    expect(service.check_availability({ tenant_id: TENANT_ID, provider_id: PROVIDER_ID, ...WINDOW_ONE })).toBe(false);
    expect(service.release_hold({ hold_id: hold.hold_id, tenant_id: TENANT_ID })).toBe(true);
    expect(service.release_hold({ hold_id: hold.hold_id, tenant_id: TENANT_ID })).toBe(false);
    expect(service.check_availability({ tenant_id: TENANT_ID, provider_id: PROVIDER_ID, ...WINDOW_ONE })).toBe(true);
  });

  it("test_cancel_booking_frees_window_only_for_owning_tenant", () => {
    const hold = service.hold_slot({ tenant_id: TENANT_ID, provider_id: PROVIDER_ID, ...WINDOW_ONE });
    const appointment = service.confirm_hold({
      hold_id: hold.hold_id,
      tenant_id: TENANT_ID,
      idempotency_key: "cancel-key",
    });

    service.cancel_booking({ appointment_id: appointment.id, tenant_id: "tenant_other" });
    expect(service.check_availability({ tenant_id: TENANT_ID, provider_id: PROVIDER_ID, ...WINDOW_ONE })).toBe(false);
    service.cancel_booking({ appointment_id: appointment.id, tenant_id: TENANT_ID });
    expect(service.check_availability({ tenant_id: TENANT_ID, provider_id: PROVIDER_ID, ...WINDOW_ONE })).toBe(true);
    service.cancel_booking({ appointment_id: appointment.id, tenant_id: TENANT_ID });
    expect(service.get_appointment({ appointment_id: appointment.id, tenant_id: TENANT_ID })?.status).toBe("cancelled");
  });
});
