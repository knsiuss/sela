/** Public API of the concierge-grade slot broker. */

export {
  FCFS_POLICY_VERSION,
  FCFS_PRIMARY_ORDER,
  FCFS_TIE_BREAK_RULE,
  MAX_FAIRNESS_OFFERS,
  type BrokerSearchAudit,
  type BrokerSearchResult,
  type ConsentCard,
  type EligibilityAudit,
  type EligibilityDecision,
  type EligibilityReason,
  type EligibilityResult,
  type ExcludedTenant,
  type FairnessPlan,
  type FairnessPolicy,
  type MatchedSlot,
  type Offer,
  type OfferAction,
  type SearchIntent,
  type TenantAvailability,
  type TenantAvailabilityProvider,
  type TenantSlot,
} from "./types.js";
export {
  MAX_SLOTS_PER_TENANT,
  MAX_TENANTS_PER_SEARCH,
  SlotBrokerValidationError,
  validate_availability_set,
  validate_fairness_policy,
  validate_matched_slots,
  validate_search_intent,
  type SlotBrokerValidationCode,
} from "./validation.js";
export { filter_eligible_tenants } from "./eligibility.js";
export { apply_fairness_policy, build_fairness_plan, DEFAULT_FAIRNESS_POLICY } from "./fairness.js";
export { CONSENT_CARD_ACTIONS, build_offers } from "./offer_builder.js";
export { InMemoryTenantAvailabilityProvider } from "./in_memory_availability_provider.js";
export { AvailabilityProviderError, CrossTenantSlotBroker, SlotBroker } from "./broker.js";
