import { describe, expect, it } from "vitest";
import {
  build_webhook_idempotency_key,
  canonical_json,
  sign_appointment_webhook,
  verify_appointment_webhook,
  InMemoryWebhookDedupe,
  WebhookAuthError,
  type AppointmentWebhookEvent,
} from "../src/enterprise/appointment_webhooks.js";

const SECRET = "subscriber-secret-value-1234567890";
const EVENT: AppointmentWebhookEvent = {
  event_id: "evt-1",
  tenant_id: "42",
  event_type: "rescheduled",
  occurred_at_iso: "2026-09-30T00:00:00.000Z",
  idempotency_key: "idem-1",
  payload: { appointment_id: "appt-1", slot_ref: "slot-9" },
};

describe("appointment webhooks", () => {
  it("signs and verifies a round-trip", () => {
    const signed = sign_appointment_webhook(EVENT, SECRET, "2026-09-30T00:00:00.000Z");
    expect(signed.signature.startsWith("sha256=")).toBe(true);
    const body = JSON.stringify({ event: signed.event, timestamp_iso: signed.timestamp_iso });
    const parsed = verify_appointment_webhook(
      body, signed.signature, SECRET, new Date("2026-09-30T00:01:00.000Z"),
    );
    expect(parsed.event_id).toBe("evt-1");
  });

  it("rejects tampered bodies", () => {
    const signed = sign_appointment_webhook(EVENT, SECRET, "2026-09-30T00:00:00.000Z");
    const tampered = JSON.stringify({
      event: { ...EVENT, payload: { appointment_id: "appt-1", slot_ref: "slot-evil" } },
      timestamp_iso: signed.timestamp_iso,
    });
    expect(() => verify_appointment_webhook(
      tampered, signed.signature, SECRET, new Date("2026-09-30T00:01:00.000Z"),
    )).toThrow("webhook-signature-mismatch");
  });

  it("rejects stale timestamps", () => {
    const signed = sign_appointment_webhook(EVENT, SECRET, "2026-09-30T00:00:00.000Z");
    const body = JSON.stringify({ event: EVENT, timestamp_iso: signed.timestamp_iso });
    expect(() => verify_appointment_webhook(
      body, signed.signature, SECRET, new Date("2026-09-30T02:00:00.000Z"),
    )).toThrow("webhook-timestamp-skew");
  });

  it("dedupes replay by idempotency key and conflicts on fingerprint change", () => {
    const dedupe = new InMemoryWebhookDedupe();
    expect(dedupe.claim(EVENT)).toBe(true);
    expect(dedupe.claim(EVENT)).toBe(false);
    expect(() => dedupe.claim({ ...EVENT, payload: { appointment_id: "appt-1", slot_ref: "other" } }))
      .toThrow("webhook-fingerprint-conflict");
  });

  it("builds stable idempotency keys and canonical payloads", () => {
    expect(build_webhook_idempotency_key(EVENT)).toBe("wh:42:evt-1");
    expect(canonical_json({ b: "2", a: "1" })).toBe('{"a":"1","b":"2"}');
    expect(() => sign_appointment_webhook(EVENT, "short", "2026-09-30T00:00:00.000Z"))
      .toThrow(WebhookAuthError);
  });
});
