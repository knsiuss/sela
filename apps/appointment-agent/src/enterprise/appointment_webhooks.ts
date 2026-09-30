/** Authenticated appointment-change webhooks: sign, verify, replay safely. */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** Appointment lifecycle events published to enterprise subscribers. */
export type AppointmentWebhookType = "created" | "updated" | "cancelled" | "rescheduled";

/** One appointment-change event; payload carries refs only, never PII. */
export interface AppointmentWebhookEvent {
  event_id: string;
  tenant_id: string;
  event_type: AppointmentWebhookType;
  occurred_at_iso: string;
  idempotency_key: string;
  payload: Record<string, string>;
}

/** Signed envelope handed to the subscriber transport. */
export interface SignedAppointmentWebhook {
  event: AppointmentWebhookEvent;
  timestamp_iso: string;
  payload_hash: string;
  signature: string;
}

/** Failure with a stable machine-readable code. */
export class WebhookAuthError extends Error {
  readonly code: string;

  /** Create a sanitized webhook failure. */
  constructor(code: string) {
    super(code);
    this.name = "WebhookAuthError";
    this.code = code;
  }
}

const MAX_SKEW_SECONDS = 300;
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Build the stable idempotency key for an event.
 *
 * @param event - Webhook event.
 * @returns Stable key namespaced by tenant and event id.
 */
export function build_webhook_idempotency_key(event: AppointmentWebhookEvent): string {
  const current = require_event(event);
  return `wh:${current.tenant_id}:${current.event_id}`;
}

/**
 * Sign an appointment-change event with a per-tenant secret.
 *
 * @param event - Event to sign.
 * @param secret - Per-tenant subscriber secret.
 * @param timestamp_iso - Signing time, defaults to now.
 * @returns Signed envelope.
 */
export function sign_appointment_webhook(
  event: AppointmentWebhookEvent,
  secret: string,
  timestamp_iso?: string,
): SignedAppointmentWebhook {
  const current = require_event(event);
  require_secret(secret);
  const timestamp = timestamp_iso ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(timestamp))) throw new WebhookAuthError("webhook-timestamp-invalid");
  const payload_hash = hash_secret_text(canonical_json(current.payload));
  const signature = compute_signature(current, secret, timestamp, payload_hash);
  return { event: { ...current, payload: { ...current.payload } }, timestamp_iso: timestamp, payload_hash, signature };
}

/**
 * Verify a received webhook envelope with constant-time comparison.
 *
 * @param raw_body - Exact raw body bytes.
 * @param signature_header - sha256=hex header value.
 * @param secret - Per-tenant subscriber secret.
 * @param now - Clock for skew checks.
 * @returns Parsed event when valid.
 */
export function verify_appointment_webhook(
  raw_body: Buffer | string,
  signature_header: string | undefined,
  secret: string,
  now: Date = new Date(),
): AppointmentWebhookEvent {
  require_secret(secret);
  if (Buffer.byteLength(raw_body) > MAX_BODY_BYTES) throw new WebhookAuthError("webhook-body-too-large");
  const event = parse_body(raw_body);
  const timestamp = extract_timestamp(raw_body);
  const skew_seconds = Math.abs(now.getTime() - Date.parse(timestamp)) / 1000;
  if (!Number.isFinite(skew_seconds) || skew_seconds > MAX_SKEW_SECONDS) throw new WebhookAuthError("webhook-timestamp-skew");
  const expected = compute_signature(event, secret, timestamp, hash_secret_text(canonical_json(event.payload)));
  if (!valid_header(signature_header, expected)) throw new WebhookAuthError("webhook-signature-mismatch");
  return event;
}

/**
 * Render canonical JSON with sorted keys for stable hashing.
 *
 * @param value - Payload to canonicalize.
 * @returns Canonical string.
 */
export function canonical_json(value: Record<string, string>): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WebhookAuthError("webhook-payload-invalid");
  }
  const entries = Object.entries(value);
  if (entries.length > 32) throw new WebhookAuthError("webhook-payload-too-large");
  for (const [key, item] of entries) {
    if (typeof key !== "string" || key.length < 1 || key.length > 128) throw new WebhookAuthError("webhook-payload-invalid");
    if (typeof item !== "string" || item.length > 1024) throw new WebhookAuthError("webhook-payload-invalid");
  }
  return JSON.stringify(Object.fromEntries([...entries].sort(([left], [right]) => (left < right ? -1 : 1))));
}

/** Replay dedupe: claim each idempotency key once, reject fingerprint conflicts. */
export class InMemoryWebhookDedupe {
  private readonly fingerprints = new Map<string, string>();

  /**
   * Claim an event key; returns true when first seen.
   *
   * @param event - Event to claim.
   * @returns True for new keys, false for exact duplicates.
   */
  claim(event: AppointmentWebhookEvent): boolean {
    const current = require_event(event);
    const key = build_webhook_idempotency_key(current);
    const fingerprint = hash_secret_text(canonical_json(current.payload));
    const existing = this.fingerprints.get(key);
    if (existing === undefined) {
      this.fingerprints.set(key, fingerprint);
      return true;
    }
    if (existing !== fingerprint) throw new WebhookAuthError("webhook-fingerprint-conflict");
    return false;
  }
}

function compute_signature(
  event: AppointmentWebhookEvent,
  secret: string,
  timestamp_iso: string,
  payload_hash: string,
): string {
  const material = `${timestamp_iso}.${event.event_id}.${event.tenant_id}.${event.event_type}.${payload_hash}`;
  return `sha256=${createHmac("sha256", secret).update(material, "utf8").digest("hex")}`;
}

function valid_header(header: string | undefined, expected: string): boolean {
  if (typeof header !== "string" || !header.startsWith("sha256=")) return false;
  const left = Buffer.from(header.toLowerCase(), "utf8");
  const right = Buffer.from(expected.toLowerCase(), "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function parse_body(raw_body: Buffer | string): AppointmentWebhookEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw_body.toString("utf8"));
  } catch {
    throw new WebhookAuthError("webhook-body-invalid");
  }
  if (typeof parsed !== "object" || parsed === null) throw new WebhookAuthError("webhook-body-invalid");
  const record = parsed as Record<string, unknown>;
  const envelope = (record["event"] ?? record) as Record<string, unknown>;
  return require_event({
    event_id: envelope["event_id"],
    tenant_id: envelope["tenant_id"],
    event_type: envelope["event_type"],
    occurred_at_iso: envelope["occurred_at_iso"],
    idempotency_key: envelope["idempotency_key"],
    payload: envelope["payload"],
  } as unknown as AppointmentWebhookEvent);
}

function extract_timestamp(raw_body: Buffer | string): string {
  try {
    const parsed = JSON.parse(raw_body.toString("utf8")) as Record<string, unknown>;
    const timestamp = parsed["timestamp_iso"];
    if (typeof timestamp === "string" && Number.isFinite(Date.parse(timestamp))) return timestamp;
    const event = (parsed["event"] ?? {}) as Record<string, unknown>;
    const occurred = event["occurred_at_iso"];
    if (typeof occurred === "string" && Number.isFinite(Date.parse(occurred))) return occurred;
  } catch {
    throw new WebhookAuthError("webhook-body-invalid");
  }
  throw new WebhookAuthError("webhook-timestamp-invalid");
}

function require_event(value: AppointmentWebhookEvent): AppointmentWebhookEvent {
  if (typeof value !== "object" || value === null) throw new WebhookAuthError("webhook-event-invalid");
  if (typeof value.event_id !== "string" || value.event_id.length < 1 || value.event_id.length > 256) {
    throw new WebhookAuthError("webhook-event-invalid");
  }
  if (typeof value.tenant_id !== "string" || !/^[1-9]\d{0,18}$/.test(value.tenant_id)) {
    throw new WebhookAuthError("webhook-tenant-invalid");
  }
  if (!is_type(value.event_type)) throw new WebhookAuthError("webhook-type-invalid");
  if (typeof value.occurred_at_iso !== "string" || !Number.isFinite(Date.parse(value.occurred_at_iso))) {
    throw new WebhookAuthError("webhook-event-invalid");
  }
  if (typeof value.idempotency_key !== "string" || value.idempotency_key.length < 1
    || value.idempotency_key.length > 256) throw new WebhookAuthError("webhook-event-invalid");
  if (typeof value.payload !== "object" || value.payload === null) throw new WebhookAuthError("webhook-payload-invalid");
  canonical_json(value.payload);
  return value;
}

function is_type(value: unknown): value is AppointmentWebhookType {
  return value === "created" || value === "updated" || value === "cancelled" || value === "rescheduled";
}

function require_secret(value: string): string {
  if (typeof value !== "string" || value.length < 16 || value.length > 512) {
    throw new WebhookAuthError("webhook-secret-invalid");
  }
  return value;
}

function hash_secret_text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
