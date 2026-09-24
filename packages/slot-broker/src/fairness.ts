/** Deterministic FCFS fairness ranking for eligible availability matches. */

import {
  FCFS_POLICY_VERSION,
  FCFS_PRIMARY_ORDER,
  FCFS_TIE_BREAK_RULE,
  MAX_FAIRNESS_OFFERS,
  type FairnessPlan,
  type FairnessPolicy,
  type MatchedSlot,
} from "./types.js";
import { validate_fairness_policy, validate_matched_slots } from "./validation.js";

/** Default policy for the concierge pilot. */
export const DEFAULT_FAIRNESS_POLICY: FairnessPolicy = Object.freeze({
  policy_version: FCFS_POLICY_VERSION,
  max_offers: MAX_FAIRNESS_OFFERS,
  primary_order: FCFS_PRIMARY_ORDER,
  tie_break_rule: FCFS_TIE_BREAK_RULE,
});

function compare_text(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compare_slots(left: MatchedSlot, right: MatchedSlot): number {
  const created_at_difference = Date.parse(left.created_at) - Date.parse(right.created_at);
  if (created_at_difference !== 0) return created_at_difference;
  const tenant_difference = compare_text(left.tenant_id, right.tenant_id);
  if (tenant_difference !== 0) return tenant_difference;
  return compare_text(left.slot_id, right.slot_id);
}

/**
 * Rank eligible slots with a documented, non-LLM fairness policy.
 *
 * FCFS compares tenant availability `created_at` ascending. Equal timestamps
 * are resolved by `tenant_id` ascending, then `slot_id` ascending. The plan
 * only controls presentation order; it does not reserve or write a slot.
 *
 * Args:
 *   matched_slots: Slots that already passed eligibility.
 *   policy: Explicit policy; defaults to the versioned pilot policy.
 *
 * Returns:
 *   A versioned plan containing ordered, selected, and capacity-excluded slots.
 *
 * Raises:
 *   SlotBrokerValidationError: If the policy or slot data is invalid.
 */
export function build_fairness_plan(
  matched_slots: readonly MatchedSlot[],
  policy: FairnessPolicy = DEFAULT_FAIRNESS_POLICY,
): FairnessPlan {
  validate_fairness_policy(policy);
  validate_matched_slots(matched_slots);
  const ordered_slots = [...matched_slots].sort(compare_slots);
  return {
    policy: { ...policy },
    policy_version: policy.policy_version,
    ordered_slots,
    selected_slots: ordered_slots.slice(0, policy.max_offers),
    excluded_slots: ordered_slots.slice(policy.max_offers),
  };
}

/** Alias with an imperative name for callers that prefer it. */
export const apply_fairness_policy = build_fairness_plan;
