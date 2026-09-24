/** Build read-only WhatsApp offers; this module never books a slot. */

import {
  FCFS_POLICY_VERSION,
  type ConsentCard,
  type MatchedSlot,
  type Offer,
  type OfferAction,
  type SearchIntent,
} from "./types.js";
import { SlotBrokerValidationError, validate_matched_slots, validate_search_intent } from "./validation.js";

/** English WhatsApp action labels used by every consent card. */
export const CONSENT_CARD_ACTIONS: Readonly<Record<OfferAction, string>> = Object.freeze({
  choose: "Choose",
  decline: "Not now",
});

function get_tenant_names(matched_slots: readonly MatchedSlot[]): string[] {
  const names: string[] = [];
  const seen_tenant_ids = new Set<string>();
  for (const matched_slot of matched_slots) {
    if (!seen_tenant_ids.has(matched_slot.tenant_id)) {
      seen_tenant_ids.add(matched_slot.tenant_id);
      names.push(matched_slot.tenant_name);
    }
  }
  return names;
}

function build_summary(matched_slots: readonly MatchedSlot[]): string {
  const tenant_names = get_tenant_names(matched_slots);
  if (tenant_names.length === 0) return "No eligible partner slots are available.";
  const slot_word = matched_slots.length === 1 ? "slot" : "slots";
  return `${matched_slots.length} ${slot_word} available at: ${tenant_names.join(", ")}`;
}

function build_consent_card(matched_slot: MatchedSlot): ConsentCard {
  return {
    card_type: "slot_consent",
    tenant_id: matched_slot.tenant_id,
    tenant_name: matched_slot.tenant_name,
    slot_id: matched_slot.slot_id,
    title: `Review slot at ${matched_slot.tenant_name}`,
    body:
      `${matched_slot.start_time} to ${matched_slot.end_time}. ` +
      `Reply "Choose" to send this option to a staff member for approval, or "Not now" to decline. ` +
      "No booking is made automatically.",
    actions: CONSENT_CARD_ACTIONS,
    requires_explicit_response: true,
  };
}

/**
 * Convert ranked matches into WhatsApp consent-card offers.
 *
 * The common summary names every included tenant, while each returned offer
 * contains one slot card with explicit Choose/Not now actions. No action is
 * executed here and every offer remains pending human approval.
 *
 * Args:
 *   matched_slots: Ranked, eligible matches.
 *   intent: Requester intent used to preserve consent and requester identity.
 *   policy_version: Version stamped on each offer; defaults to FCFS v1.
 *
 * Returns:
 *   One read-only offer per matched slot, or an empty list without consent.
 *
 * Raises:
 *   SlotBrokerValidationError: If either input fails the boundary contract.
 */
export function build_offers(
  matched_slots: readonly MatchedSlot[],
  intent: SearchIntent,
  policy_version: string = FCFS_POLICY_VERSION,
): Offer[] {
  validate_search_intent(intent);
  validate_matched_slots(matched_slots);
  if (typeof policy_version !== "string" || policy_version.trim() === "") {
    throw new SlotBrokerValidationError("invalid_fairness_policy", "policy_version");
  }
  if (intent.consent_granted !== true) return [];
  const summary = build_summary(matched_slots);
  return matched_slots.map((matched_slot, slot_index) => {
    const matched_slot_copy = { ...matched_slot };
    return {
      offer_id: `offer_${slot_index + 1}`,
      requester_tenant_id: intent.requester_tenant_id,
      consent_granted: true,
      tenant_id: matched_slot_copy.tenant_id,
      tenant_name: matched_slot_copy.tenant_name,
      matched_slot: matched_slot_copy,
      summary,
      consent_card: build_consent_card(matched_slot_copy),
      approval_status: "pending_human_approval",
      requires_human_approval: true,
      booking_state: "not_booked",
      policy_version,
    };
  });
}
