/** Shared contracts for the concierge-grade cross-tenant slot broker. */

/** Maximum number of offers shown in one fairness-ranked result. */
export const MAX_FAIRNESS_OFFERS = 3;

/** Stable version for the deterministic first-created-at fairness policy. */
export const FCFS_POLICY_VERSION = "fcfs-created-at-v1";

/** Primary ordering used by the fairness policy. */
export const FCFS_PRIMARY_ORDER = "created_at_ascending";

/** Stable ordering used when two availability records have the same timestamp. */
export const FCFS_TIE_BREAK_RULE = "tenant_id_then_slot_id_ascending";

/** A customer request to find an eligible slot without reserving anything. */
export interface SearchIntent {
  /** Tenant through which the requester entered the broker. */
  requester_tenant_id: string;
  /** Explicit requester opt-in to query partner tenants. */
  consent_granted: boolean;
  /** Vertical requested by the customer, such as clinic or salon. */
  vertical: string;
  /** Locale requested by the customer. */
  locale: string;
  /** Inclusive start of the requested availability window, in ISO format. */
  start_time: string;
  /** Exclusive end of the requested availability window, in ISO format. */
  end_time: string;
}

/** The minimum slot information a partner may expose to the broker. */
export interface TenantSlot {
  slot_id: string;
  start_time: string;
  end_time: string;
}

/** Availability and sharing permissions for one partner tenant. */
export interface TenantAvailability {
  tenant_id: string;
  tenant_name: string;
  vertical: string;
  locale: string;
  /** Partner consent to expose the minimum availability fields. */
  consent_granted: boolean;
  /** Whether an active partner contract permits broker discovery. */
  has_partner_contract: boolean;
  /** Timestamp used by the fairness policy for this tenant's waitlist entry. */
  created_at: string;
  slots: readonly TenantSlot[];
}

/** A slot that passed eligibility and is ready for deterministic ranking. */
export interface MatchedSlot {
  tenant_id: string;
  tenant_name: string;
  slot_id: string;
  start_time: string;
  end_time: string;
  created_at: string;
  vertical: string;
  locale: string;
}

/** Actions a customer can take on a consent card. */
export type OfferAction = "choose" | "decline";

/** A WhatsApp consent card; the broker never executes either action. */
export interface ConsentCard {
  card_type: "slot_consent";
  tenant_id: string;
  tenant_name: string;
  slot_id: string;
  title: string;
  body: string;
  actions: Readonly<Record<OfferAction, string>>;
  requires_explicit_response: true;
}

/** A read-only, human-approval-required offer returned to the requester. */
export interface Offer {
  offer_id: string;
  requester_tenant_id: string;
  consent_granted: true;
  tenant_id: string;
  tenant_name: string;
  matched_slot: MatchedSlot;
  summary: string;
  consent_card: ConsentCard;
  approval_status: "pending_human_approval";
  requires_human_approval: true;
  booking_state: "not_booked";
  policy_version: string;
}

/** Deterministic fairness configuration exposed in every plan. */
export interface FairnessPolicy {
  policy_version: string;
  max_offers: number;
  primary_order: typeof FCFS_PRIMARY_ORDER;
  tie_break_rule: typeof FCFS_TIE_BREAK_RULE;
}

/** The ranked result of applying the fairness policy. */
export interface FairnessPlan {
  policy: FairnessPolicy;
  policy_version: string;
  ordered_slots: readonly MatchedSlot[];
  selected_slots: readonly MatchedSlot[];
  excluded_slots: readonly MatchedSlot[];
}

/** Machine-readable reasons recorded when a tenant cannot participate. */
export type EligibilityReason =
  | "requester_consent_not_granted"
  | "requester_tenant_excluded"
  | "tenant_consent_not_granted"
  | "partner_contract_missing"
  | "vertical_mismatch"
  | "locale_mismatch"
  | "no_available_slots"
  | "no_slots_in_requested_window";

/** One auditable eligibility decision for a tenant record. */
export interface EligibilityDecision {
  tenant_id: string;
  is_eligible: boolean;
  reasons: readonly EligibilityReason[];
}

/** Minimal exclusion record; it intentionally omits partner slot data. */
export interface ExcludedTenant {
  tenant_id: string;
  reason: EligibilityReason;
  reasons: readonly EligibilityReason[];
  audit_reason: string;
}

/** Eligibility result containing only permitted availability for matches. */
export interface EligibilityResult {
  eligible_tenants: readonly TenantAvailability[];
  excluded_tenants: readonly ExcludedTenant[];
  decisions: readonly EligibilityDecision[];
}

/** Minimal eligibility evidence safe to retain in an operator audit. */
export interface EligibilityAudit {
  excluded_tenants: readonly ExcludedTenant[];
  decisions: readonly EligibilityDecision[];
}

/** Audit context returned when callers need more than the user-facing offers. */
export interface BrokerSearchAudit {
  eligibility: EligibilityAudit;
  fairness: FairnessPlan;
}

/** Full broker result used by operators and audit-aware callers. */
export interface BrokerSearchResult {
  offers: readonly Offer[];
  audit: BrokerSearchAudit;
}

/** Read-only port for partner availability. Implementations must not mutate calendars. */
export interface TenantAvailabilityProvider {
  get_availability(intent: SearchIntent): Promise<readonly TenantAvailability[]>;
}
