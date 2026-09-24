import type { BillingTag, DeliveryReceipt, DeliveryStatus, TemplateCategory } from "./types.js";

/** Safe failures while normalizing a provider status event. */
export type BillingNormalizationCode = "invalid_status" | "invalid_pricing" | "invalid_status_data";

/** Error that never includes the provider payload or recipient data. */
export class BillingNormalizationError extends Error {
  /** Stable machine-readable reason. */
  readonly code: BillingNormalizationCode;

  /**
   * Create a safe status normalization error.
   *
   * @param code - Stable reason without raw provider content.
   */
  constructor(code: BillingNormalizationCode) {
    super(`billing-normalization-failed: ${code}`);
    this.name = "BillingNormalizationError";
    this.code = code;
  }
}

/** Maximum status messages processed from one webhook value. */
export const MAX_STATUS_MESSAGES = 1_000;

/** Maximum nesting depth inspected while finding webhook status messages. */
const MAX_STATUS_DEPTH = 8;

/** Threshold above which a numeric Meta timestamp is already in milliseconds. */
const MILLISECOND_TIMESTAMP_THRESHOLD = 10_000_000_000;

/** JavaScript Date's supported positive/negative epoch range. */
const MAX_DATE_EPOCH_MS = 8_640_000_000_000_000;

/** Valid Meta delivery states represented by the package contract. */
const DELIVERY_STATUSES: readonly DeliveryStatus[] = ["sent", "delivered", "read", "failed"];

/** Valid Meta template categories represented by the package contract. */
const TEMPLATE_CATEGORIES: readonly TemplateCategory[] = ["marketing", "utility", "authentication"];

/**
 * Normalize one Meta message-status object into a safe receipt.
 *
 * Only WAMID, delivery state, timestamp, pricing fields, and a provider error
 * code are retained. Contact identifiers, phone numbers, metadata, titles, and
 * raw response bodies are intentionally discarded.
 *
 * @param value - One untrusted Meta status message object.
 * @returns A receipt containing no PII or raw provider payload.
 * @throws BillingNormalizationError when required status fields are invalid.
 */
export function normalize_delivery_receipt(value: unknown): DeliveryReceipt {
  if (!is_record(value)) throw new BillingNormalizationError("invalid_status");
  const wamid = require_identifier(value.id);
  const status = read_delivery_status(value.status);
  const occurred_at_iso = normalize_timestamp(value.timestamp);
  const billing = normalize_billing_tag(value.pricing);
  const error_code = normalize_error_code(value.errors ?? value.error_code);
  return {
    wamid,
    status,
    ...(occurred_at_iso === undefined ? {} : { occurred_at_iso }),
    ...(billing === undefined ? {} : { billing }),
    ...(error_code === undefined ? {} : { error_code }),
  };
}

/**
 * Normalize status messages from a raw Meta webhook value.
 *
 * The function understands a single message, an array of messages, and the
 * nested `entry[].changes[].value.messages[]` webhook shape. It never returns the
 * original object or any contact metadata.
 *
 * @param value - Untrusted webhook status data.
 * @returns Safe receipts in provider order.
 * @throws BillingNormalizationError for an invalid container or status item.
 */
export function normalize_delivery_receipts(value: unknown): DeliveryReceipt[] {
  if (Array.isArray(value)) {
    if (value.length > MAX_STATUS_MESSAGES) throw new BillingNormalizationError("invalid_status_data");
    return value.map((message) => normalize_delivery_receipt(message));
  }
  if (!is_record(value)) throw new BillingNormalizationError("invalid_status_data");
  const messages = collect_status_messages(value);
  return messages.map((message) => normalize_delivery_receipt(message));
}

/** Alias for webhook-oriented callers. */
export const normalize_meta_status_data = normalize_delivery_receipts;

/** Alias for callers that use delivery-status terminology. */
export const normalize_delivery_status = normalize_delivery_receipt;

/**
 * Try to normalize one status item without leaking a malformed event.
 *
 * @param value - Candidate status item.
 * @returns A safe receipt or undefined when the item is invalid.
 */
export function try_normalize_delivery_receipt(value: unknown): DeliveryReceipt | undefined {
  try {
    return normalize_delivery_receipt(value);
  } catch (error) {
    if (error instanceof BillingNormalizationError) return undefined;
    throw error;
  }
}

/**
 * Normalize a pricing object into a safe billing tag.
 *
 * @param value - Candidate Meta pricing object.
 * @returns A copied billing tag or undefined when pricing is absent.
 * @throws BillingNormalizationError when present pricing is malformed.
 */
export function normalize_billing_tag(value: unknown): BillingTag | undefined {
  if (value === undefined || value === null) return undefined;
  if (!is_record(value) || typeof value.billable !== "boolean") {
    throw new BillingNormalizationError("invalid_pricing");
  }
  const pricing_model = require_provider_token(value.pricing_model);
  const type = require_provider_token(value.type);
  const category = read_template_category(value.category);
  return { billable: value.billable, pricing_model, category, type };
}

/** Alias for callers that use the shorter billing terminology. */
export const normalize_billing = normalize_billing_tag;

function collect_status_messages(value: unknown): unknown[] {
  const messages: unknown[] = [];
  const visited = new Set<object>();
  const visit = (candidate: unknown, depth: number): void => {
    if (depth > MAX_STATUS_DEPTH) throw new BillingNormalizationError("invalid_status_data");
    if (messages.length >= MAX_STATUS_MESSAGES) {
      throw new BillingNormalizationError("invalid_status_data");
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item, depth + 1);
      return;
    }
    if (!is_record(candidate)) return;
    if (visited.has(candidate)) throw new BillingNormalizationError("invalid_status_data");
    visited.add(candidate);
    if (typeof candidate.id === "string" && typeof candidate.status === "string") {
      messages.push(candidate);
      return;
    }
    for (const key of ["messages", "entry", "changes", "value"]) {
      if (candidate[key] === undefined) continue;
      if ((key === "messages" || key === "entry" || key === "changes") && !Array.isArray(candidate[key])) {
        throw new BillingNormalizationError("invalid_status_data");
      }
      if (key === "value" && !is_record(candidate[key])) {
        throw new BillingNormalizationError("invalid_status_data");
      }
      visit(candidate[key], depth + 1);
    }
  };
  visit(value, 0);
  return messages;
}

function read_delivery_status(value: unknown): DeliveryStatus {
  if (typeof value === "string" && DELIVERY_STATUSES.includes(value as DeliveryStatus)) {
    return value as DeliveryStatus;
  }
  throw new BillingNormalizationError("invalid_status");
}

function read_template_category(value: unknown): TemplateCategory {
  if (typeof value === "string" && TEMPLATE_CATEGORIES.includes(value as TemplateCategory)) {
    return value as TemplateCategory;
  }
  throw new BillingNormalizationError("invalid_pricing");
}

function normalize_timestamp(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  let epoch_ms: number;
  if (typeof value === "number") {
    epoch_ms = value > MILLISECOND_TIMESTAMP_THRESHOLD ? value : value * 1_000;
  } else if (typeof value === "string" && /^\d+(?:\.\d+)?$/u.test(value)) {
    const numeric = Number(value);
    epoch_ms = numeric > MILLISECOND_TIMESTAMP_THRESHOLD ? numeric : numeric * 1_000;
  } else if (typeof value === "string") {
    epoch_ms = Date.parse(value);
  } else {
    epoch_ms = Number.NaN;
  }
  if (!Number.isFinite(epoch_ms) || Math.abs(epoch_ms) > MAX_DATE_EPOCH_MS) return undefined;
  const date = new Date(epoch_ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function normalize_error_code(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const error of value) {
      const code = read_error_code(error);
      if (code !== undefined) return code;
    }
    return undefined;
  }
  return read_error_code(value);
}

function read_error_code(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "string") return is_safe_provider_code(value) ? value : undefined;
  if (!is_record(value)) return undefined;
  const candidate = value.code ?? value.error_code;
  if (typeof candidate === "object" && candidate !== null) return undefined;
  return read_error_code(candidate);
}

function require_identifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new BillingNormalizationError("invalid_status");
  }
  return value;
}

function require_provider_token(value: unknown): string {
  if (typeof value !== "string" || !is_safe_provider_code(value)) {
    throw new BillingNormalizationError("invalid_pricing");
  }
  return value;
}

function is_safe_provider_code(value: string): boolean {
  return value.length > 0 && value.length <= 128 && /^[A-Za-z0-9_.:-]+$/u.test(value);
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
