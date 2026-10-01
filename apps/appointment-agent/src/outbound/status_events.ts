/** Strict extraction of Meta outbound status events without recipient data. */

import type { OutboundDeliveryStatusEvent } from "./outbound_ledger.js";

/** Status event paired with the phone-number channel needed for tenant lookup. */
export interface ParsedOutboundStatus {
  channel_account_id: string;
  event: OutboundDeliveryStatusEvent;
}

/** Extract status nodes from a signed WhatsApp webhook payload. */
export function extract_outbound_statuses(payload: unknown): ParsedOutboundStatus[] {
  if (!is_record(payload) || !Array.isArray(payload.entry)) return [];
  const results: ParsedOutboundStatus[] = [];
  for (const entry of payload.entry) {
    if (!is_record(entry) || !Array.isArray(entry.changes)) continue;
    for (const change of entry.changes) {
      if (!is_record(change) || !is_record(change.value)) continue;
      const value = change.value;
      if (!Array.isArray(value.statuses)) continue;
      const channel_account_id = typeof value.phone_number_id === "string" ? value.phone_number_id : "";
      for (const status of value.statuses) {
        results.push({
          channel_account_id,
          event: parse_status(status),
        });
      }
    }
  }
  return results;
}

function parse_status(value: unknown): OutboundDeliveryStatusEvent {
  if (!is_record(value)) throw new Error("outbound-status-invalid");
  const provider_message_id = value.id;
  const status = value.status;
  if (typeof provider_message_id !== "string" || provider_message_id.length < 1 || provider_message_id.length > 256) {
    throw new Error("outbound-status-invalid");
  }
  if (status !== "sent" && status !== "delivered" && status !== "read" && status !== "failed") {
    throw new Error("outbound-status-invalid");
  }
  const timestamp = value.timestamp;
  const occurred_at_iso = typeof timestamp === "string" && Number.isFinite(Number(timestamp))
    ? new Date(Number(timestamp) * 1_000).toISOString()
    : undefined;
  return {
    provider: "whatsapp",
    provider_message_id,
    status,
    ...(occurred_at_iso === undefined ? {} : { occurred_at_iso }),
    ...(safe_error_code(value.errors) === undefined ? {} : { error_code: safe_error_code(value.errors) }),
  };
}

function safe_error_code(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0 || !is_record(value[0])) return undefined;
  const code = value[0].code;
  if (typeof code !== "number" && typeof code !== "string") return undefined;
  const normalized = String(code).toLowerCase().replace(/[^a-z0-9_]+/gu, "_");
  return /^[a-z0-9_]{1,64}$/.test(normalized) ? normalized : undefined;
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
