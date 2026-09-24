/** Read-only orchestration for cross-tenant availability search. */

import { filter_eligible_tenants } from "./eligibility.js";
import { build_fairness_plan, DEFAULT_FAIRNESS_POLICY } from "./fairness.js";
import { InMemoryTenantAvailabilityProvider } from "./in_memory_availability_provider.js";
import { build_offers } from "./offer_builder.js";
import {
  type BrokerSearchResult,
  type EligibilityAudit,
  type EligibilityResult,
  type FairnessPolicy,
  type MatchedSlot,
  type Offer,
  type SearchIntent,
  type TenantAvailability,
  type TenantAvailabilityProvider,
} from "./types.js";
import { validate_availability_set, validate_fairness_policy, validate_search_intent } from "./validation.js";

/** Stable, non-sensitive error for a failed availability provider. */
export class AvailabilityProviderError extends Error {
  public constructor(cause: unknown) {
    super("slot-broker-availability-provider-failed", { cause });
    this.name = "AvailabilityProviderError";
  }
}

function to_matched_slots(availabilities: readonly TenantAvailability[]): MatchedSlot[] {
  return availabilities.flatMap((availability) =>
    availability.slots.map((slot) => ({
      tenant_id: availability.tenant_id,
      tenant_name: availability.tenant_name,
      slot_id: slot.slot_id,
      start_time: slot.start_time,
      end_time: slot.end_time,
      created_at: availability.created_at,
      vertical: availability.vertical,
      locale: availability.locale,
    })),
  );
}

function to_audit_eligibility(eligibility: EligibilityResult): EligibilityAudit {
  return {
    excluded_tenants: eligibility.excluded_tenants,
    decisions: eligibility.decisions,
  };
}

function empty_result(policy: FairnessPolicy): BrokerSearchResult {
  return {
    offers: [],
    audit: {
      eligibility: { excluded_tenants: [], decisions: [] },
      fairness: build_fairness_plan([], policy),
    },
  };
}

/**
 * Orchestrates consent, partner lookup, eligibility, fairness, and offer creation.
 *
 * The broker has no calendar writer, hold, confirmation, or booking dependency.
 * Its only side effect is calling the explicitly injected read-only provider;
 * no provider call is made when requester consent is not exactly true.
 */
export class SlotBroker {
  private readonly provider: TenantAvailabilityProvider;

  private readonly fairness_policy: FairnessPolicy;

  /**
   * Create a broker.
   *
   * Args:
   *   provider: Read-only partner availability port; defaults to an empty in-memory provider.
   *   policy: Versioned deterministic policy; defaults to FCFS v1.
   *
   * Raises:
   *   SlotBrokerValidationError: If the injected policy is invalid.
   */
  public constructor(
    provider: TenantAvailabilityProvider = new InMemoryTenantAvailabilityProvider(),
    fairness_policy: FairnessPolicy = DEFAULT_FAIRNESS_POLICY,
  ) {
    validate_fairness_policy(fairness_policy);
    this.provider = provider;
    this.fairness_policy = { ...fairness_policy };
  }

  /**
   * Search partner slots and return only user-facing offers.
   *
   * This convenience method intentionally discards the audit object after the
   * plan has been built. Operators that need the decision trail should use
   * `search_with_audit`.
   *
   * Args:
   *   intent: Untrusted requester intent.
   *
   * Returns:
   *   Ranked offers; never a booking or calendar mutation.
   *
   * Raises:
   *   SlotBrokerValidationError: If intent or provider data is invalid.
   */
  public async search(intent: SearchIntent): Promise<Offer[]> {
    const result = await this.search_with_audit(intent);
    return [...result.offers];
  }

  /**
   * Run the complete search while retaining the explainability trail.
   *
   * Args:
   *   intent: Untrusted requester intent.
   *
   * Returns:
   *   Offers plus eligibility decisions and the versioned fairness plan.
   *
   * Raises:
   *   SlotBrokerValidationError: If intent or provider data is invalid.
   */
  public async search_with_audit(intent: SearchIntent): Promise<BrokerSearchResult> {
    validate_search_intent(intent);
    if (intent.consent_granted !== true) {
      return empty_result(this.fairness_policy);
    }
    let availabilities: readonly TenantAvailability[];
    try {
      availabilities = await this.provider.get_availability(intent);
    } catch (error) {
      throw new AvailabilityProviderError(error);
    }
    validate_availability_set(availabilities);
    const eligibility = filter_eligible_tenants(intent, availabilities);
    const matched_slots = to_matched_slots(eligibility.eligible_tenants);
    const fairness = build_fairness_plan(matched_slots, this.fairness_policy);
    const offers = build_offers(fairness.selected_slots, intent, fairness.policy_version);
    return { offers, audit: { eligibility: to_audit_eligibility(eligibility), fairness } };
  }
}

/** Descriptive alias for callers that prefer the cross-tenant name. */
export { SlotBroker as CrossTenantSlotBroker };
