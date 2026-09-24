import { describe, expect, it } from "vitest";
import {
  can_send_free_form,
  requires_template,
  ServiceWindowError,
  ServiceWindowTracker,
  SERVICE_WINDOW_MS,
} from "../src/index.js";

const NOW = Date.parse("2026-10-01T12:00:00Z");

describe("WhatsApp service window", () => {
  it("allows free-form messages only inside the 24-hour inbound window", () => {
    expect(can_send_free_form(NOW, NOW - SERVICE_WINDOW_MS)).toBe(true);
    expect(can_send_free_form(NOW, NOW - SERVICE_WINDOW_MS - 1)).toBe(false);
    expect(can_send_free_form(NOW, null)).toBe(false);
    expect(requires_template(NOW, NOW - SERVICE_WINDOW_MS - 1)).toBe(true);
  });

  it("fails closed for future or invalid timestamps", () => {
    expect(can_send_free_form(NOW, NOW + 1)).toBe(false);
    expect(can_send_free_form(NOW, "not-a-date")).toBe(false);
    expect(() => new ServiceWindowTracker(() => Number.NaN).is_open()).toThrow(ServiceWindowError);
  });

  it("tracks inbound messages with an injected clock", () => {
    let now_ms = NOW;
    const tracker = new ServiceWindowTracker(() => now_ms);
    expect(tracker.is_open()).toBe(false);
    tracker.record_inbound();
    expect(tracker.last_inbound_at_ms).toBe(NOW);
    expect(tracker.is_open()).toBe(true);
    now_ms += SERVICE_WINDOW_MS + 1;
    expect(tracker.template_required()).toBe(true);
  });
});
