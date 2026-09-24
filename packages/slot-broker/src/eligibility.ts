/** Deterministic tenant eligibility checks with auditable rejection reasons. */

import {
  type EligibilityDecision,
  type EligibilityReason,
  type EligibilityResult,
  type ExcludedTenant,
  type SearchIntent,
  type TenantAvailability,
  type TenantSlot,
} from "./types.js";
import { validate_availability_set, validate_search_intent } from "./validation.js";

function normalize_dimension(value: string): string {
  return value.trim().toLowerCase();
}

function is_slot_in_window(slot: TenantSlot, intent: SearchIntent): boolean {
  const window_start_ms = Date.parse(intent.start_time);
  const window_end_ms = Date.parse(intent.end_time);
  return Date.parse(slot.start_time) >= window_start_ms && Date.parse(slot.end_time) <= window_end_ms;
}

function collect_reasons(intent: SearchIntent, availability: TenantAvailability): EligibilityReason[] {
  const reasons: EligibilityReason[] = [];
  if (intent.consent_granted !== true) {
    reasons.push("requester_consent_not_granted");
  }
  if (availability.tenant_id === intent.requester_tenant_id) {
    reasons.push("requester_tenant_excluded");
  }
  if (availability.consent_granted !== true) {
    reasons.push("tenant_consent_not_granted");
  }
  if (availability.has_partner_contract !== true) {
    reasons.push("partner_contract_missing");
  }
  if (normalize_dimension(availability.vertical) !== normalize_dimension(intent.vertical)) {
    reasons.push("vertical_mismatch");
  }
  if (normalize_dimension(availability.locale) !== normalize_dimension(intent.locale)) {
    reasons.push("locale_mismatch");
  }
  return reasons;
}

function get_slot_reason(
  availability: TenantAvailability,
  intent: SearchIntent,
): EligibilityReason | undefined {
  if (availability.slots.length === 0) {
    return "no_available_slots";
  }
  if (!availability.slots.some((slot) => is_slot_in_window(slot, intent))) {
    return "no_slots_in_requested_window";
  }
  return undefined;
}

function to_decision(tenant_id: string, reasons: readonly EligibilityReason[]): EligibilityDecision {
  return { tenant_id, is_eligible: reasons.length === 0, reasons };
}

function to_excluded_tenant(decision: EligibilityDecision): ExcludedTenant {
  const reasons = decision.reasons;
  const first_reason = reasons[0] ?? "no_available_slots";
  return {
    tenant_id: decision.tenant_id,
    reason: first_reason,
    reasons,
    audit_reason: reasons.join("|"),
  };
}

/**
 * Filter partner records before any slot is offered to a requester.
 *
 * The function is pure: it copies eligible slot arrays and never calls a
 * provider, calendar, or mutation port. A requester without explicit consent
 * produces no eligible records even if this function is called directly.
 *
 * Args:
 *   intent: Validated, untrusted requester intent.
 *   availabilities: Validated partner records returned by a provider.
 *
 * Returns:
 *   Eligible records plus machine-readable decisions and minimal exclusions.
 *
 * Raises:
 *   SlotBrokerValidationError: If either input fails the boundary contract.
 */
export function filter_eligible_tenants(
  intent: SearchIntent,
  availabilities: readonly TenantAvailability[],
): EligibilityResult {
  validate_search_intent(intent);
  validate_availability_set(availabilities);
  const eligible_tenants: TenantAvailability[] = [];
  const excluded_tenants: ExcludedTenant[] = [];
  const decisions: EligibilityDecision[] = [];

  for (const availability of availabilities) {
    const reasons = collect_reasons(intent, availability);
    const slot_reason = get_slot_reason(availability, intent);
    if (slot_reason !== undefined) {
      reasons.push(slot_reason);
    }
    const decision = to_decision(availability.tenant_id, reasons);
    decisions.push(decision);
    if (decision.is_eligible) {
      eligible_tenants.push({
        ...availability,
        slots: availability.slots.filter((slot) => is_slot_in_window(slot, intent)),
      });
    } else {
      excluded_tenants.push(to_excluded_tenant(decision));
    }
  }

  return { eligible_tenants, excluded_tenants, decisions };
}
