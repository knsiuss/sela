/** Runtime validation for untrusted broker inputs. */

import {
  FCFS_PRIMARY_ORDER,
  FCFS_TIE_BREAK_RULE,
  MAX_FAIRNESS_OFFERS,
  type FairnessPolicy,
  type MatchedSlot,
  type SearchIntent,
  type TenantAvailability,
} from "./types.js";

/** Maximum partner records accepted from one provider response. */
export const MAX_TENANTS_PER_SEARCH = 50;

/** Maximum slots accepted for one partner in one response. */
export const MAX_SLOTS_PER_TENANT = 20;

/** Stable error code for rejected external input. */
export type SlotBrokerValidationCode =
  | "invalid_search_intent"
  | "invalid_tenant_availability"
  | "invalid_matched_slot"
  | "invalid_fairness_policy";

/** Typed error that fails closed without echoing untrusted values. */
export class SlotBrokerValidationError extends Error {
  public readonly code: SlotBrokerValidationCode;

  public constructor(code: SlotBrokerValidationCode, field_name: string) {
    super(`slot-broker-${code}: ${field_name}`);
    this.name = "SlotBrokerValidationError";
    this.code = code;
  }
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function require_string(value: unknown, field_name: string, code: SlotBrokerValidationCode): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SlotBrokerValidationError(code, field_name);
  }
  return value;
}

function require_boolean(value: unknown, field_name: string, code: SlotBrokerValidationCode): boolean {
  if (typeof value !== "boolean") {
    throw new SlotBrokerValidationError(code, field_name);
  }
  return value;
}

function require_timestamp(value: unknown, field_name: string, code: SlotBrokerValidationCode): string {
  const timestamp = require_string(value, field_name, code);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(timestamp) || !Number.isFinite(Date.parse(timestamp))) {
    throw new SlotBrokerValidationError(code, field_name);
  }
  return timestamp;
}

function require_safe_display_text(
  value: unknown,
  field_name: string,
  code: SlotBrokerValidationCode,
): string {
  const text = require_string(value, field_name, code);
  if (text.length > 120 || /[\u0000-\u001F\u007F]/u.test(text)) {
    throw new SlotBrokerValidationError(code, field_name);
  }
  return text;
}

function require_range(
  start_value: unknown,
  end_value: unknown,
  start_field_name: string,
  end_field_name: string,
  code: SlotBrokerValidationCode,
): void {
  const start_time = require_timestamp(start_value, start_field_name, code);
  const end_time = require_timestamp(end_value, end_field_name, code);
  if (Date.parse(end_time) <= Date.parse(start_time)) {
    throw new SlotBrokerValidationError(code, end_field_name);
  }
}

/**
 * Validate a request before any partner provider is called.
 *
 * Args:
 *   intent: Untrusted requester intent.
 *
 * Returns:
 *   Nothing; valid input is returned unchanged.
 *
 * Raises:
 *   SlotBrokerValidationError: If required fields, flags, or the time range are invalid.
 */
export function validate_search_intent(intent: SearchIntent): void {
  if (!is_record(intent)) {
    throw new SlotBrokerValidationError("invalid_search_intent", "intent");
  }
  require_string(intent.requester_tenant_id, "requester_tenant_id", "invalid_search_intent");
  require_boolean(intent.consent_granted, "consent_granted", "invalid_search_intent");
  require_string(intent.vertical, "vertical", "invalid_search_intent");
  require_string(intent.locale, "locale", "invalid_search_intent");
  require_range(intent.start_time, intent.end_time, "start_time", "end_time", "invalid_search_intent");
}

function validate_tenant_slot(slot: unknown, field_name: string): void {
  if (!is_record(slot)) {
    throw new SlotBrokerValidationError("invalid_tenant_availability", field_name);
  }
  require_string(slot.slot_id, `${field_name}.slot_id`, "invalid_tenant_availability");
  require_range(
    slot.start_time,
    slot.end_time,
    `${field_name}.start_time`,
    `${field_name}.end_time`,
    "invalid_tenant_availability",
  );
}

function validate_tenant_availability(availability: unknown, field_name: string): void {
  if (!is_record(availability)) {
    throw new SlotBrokerValidationError("invalid_tenant_availability", field_name);
  }
  require_string(availability.tenant_id, `${field_name}.tenant_id`, "invalid_tenant_availability");
  require_safe_display_text(
    availability.tenant_name,
    `${field_name}.tenant_name`,
    "invalid_tenant_availability",
  );
  require_string(availability.vertical, `${field_name}.vertical`, "invalid_tenant_availability");
  require_string(availability.locale, `${field_name}.locale`, "invalid_tenant_availability");
  require_boolean(
    availability.consent_granted,
    `${field_name}.consent_granted`,
    "invalid_tenant_availability",
  );
  require_boolean(
    availability.has_partner_contract,
    `${field_name}.has_partner_contract`,
    "invalid_tenant_availability",
  );
  require_timestamp(availability.created_at, `${field_name}.created_at`, "invalid_tenant_availability");
  if (!Array.isArray(availability.slots) || availability.slots.length > MAX_SLOTS_PER_TENANT) {
    throw new SlotBrokerValidationError("invalid_tenant_availability", `${field_name}.slots`);
  }
  const slot_ids = new Set<string>();
  availability.slots.forEach((slot: unknown, slot_index: number) => {
    const slot_field_name = `${field_name}.slots[${slot_index}]`;
    validate_tenant_slot(slot, slot_field_name);
    const slot_id = (slot as Record<string, unknown>).slot_id;
    if (typeof slot_id === "string") {
      if (slot_ids.has(slot_id)) {
        throw new SlotBrokerValidationError("invalid_tenant_availability", `${slot_field_name}.slot_id`);
      }
      slot_ids.add(slot_id);
    }
  });
}

/**
 * Validate provider data before any tenant is used for matching.
 *
 * Args:
 *   availabilities: Untrusted partner availability records.
 *
 * Returns:
 *   Nothing; valid records are left unchanged.
 *
 * Raises:
 *   SlotBrokerValidationError: If a record, slot, or collection is invalid.
 */
export function validate_availability_set(
  availabilities: readonly TenantAvailability[],
): void {
  if (!Array.isArray(availabilities) || availabilities.length > MAX_TENANTS_PER_SEARCH) {
    throw new SlotBrokerValidationError("invalid_tenant_availability", "availabilities");
  }
  const tenant_ids = new Set<string>();
  availabilities.forEach((availability: TenantAvailability, tenant_index: number) => {
    validate_tenant_availability(availability, `availabilities[${tenant_index}]`);
    if (tenant_ids.has(availability.tenant_id)) {
      throw new SlotBrokerValidationError("invalid_tenant_availability", "tenant_id");
    }
    tenant_ids.add(availability.tenant_id);
  });
}

function validate_matched_slot(slot: unknown, field_name: string): void {
  if (!is_record(slot)) {
    throw new SlotBrokerValidationError("invalid_matched_slot", field_name);
  }
  require_string(slot.tenant_id, `${field_name}.tenant_id`, "invalid_matched_slot");
  require_safe_display_text(slot.tenant_name, `${field_name}.tenant_name`, "invalid_matched_slot");
  require_string(slot.slot_id, `${field_name}.slot_id`, "invalid_matched_slot");
  require_range(
    slot.start_time,
    slot.end_time,
    `${field_name}.start_time`,
    `${field_name}.end_time`,
    "invalid_matched_slot",
  );
  require_timestamp(slot.created_at, `${field_name}.created_at`, "invalid_matched_slot");
  require_string(slot.vertical, `${field_name}.vertical`, "invalid_matched_slot");
  require_string(slot.locale, `${field_name}.locale`, "invalid_matched_slot");
}

/** Validate internally derived match objects before ranking or rendering. */
export function validate_matched_slots(slots: readonly MatchedSlot[]): void {
  if (!Array.isArray(slots) || slots.length > MAX_TENANTS_PER_SEARCH * MAX_SLOTS_PER_TENANT) {
    throw new SlotBrokerValidationError("invalid_matched_slot", "matched_slots");
  }
  slots.forEach((slot: MatchedSlot, slot_index: number) => {
    validate_matched_slot(slot, `matched_slots[${slot_index}]`);
  });
}

/** Validate the deterministic policy before it can be applied. */
export function validate_fairness_policy(policy: FairnessPolicy): void {
  if (!is_record(policy)) {
    throw new SlotBrokerValidationError("invalid_fairness_policy", "policy");
  }
  require_string(policy.policy_version, "policy_version", "invalid_fairness_policy");
  if (
    !Number.isInteger(policy.max_offers) ||
    policy.max_offers < 1 ||
    policy.max_offers > MAX_FAIRNESS_OFFERS
  ) {
    throw new SlotBrokerValidationError("invalid_fairness_policy", "max_offers");
  }
  if (policy.primary_order !== FCFS_PRIMARY_ORDER) {
    throw new SlotBrokerValidationError("invalid_fairness_policy", "primary_order");
  }
  if (policy.tie_break_rule !== FCFS_TIE_BREAK_RULE) {
    throw new SlotBrokerValidationError("invalid_fairness_policy", "tie_break_rule");
  }
}
