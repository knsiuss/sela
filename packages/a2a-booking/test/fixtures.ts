import type {
  BookingProposal,
  BookingRequest,
  ConsentGrant,
  LiabilityTerms,
  SlotOffer,
} from "../src/index.js";

export const TEST_NOW_ISO = "2026-09-24T10:00:00.000Z";
export const TEST_NOW_MS = Date.parse(TEST_NOW_ISO);
export const TEST_EXPIRES_AT_ISO = "2026-09-24T11:00:00.000Z";
export const TEST_POLICY_VERSION = "2026-09-roadmap-v1";
export const TEST_REQUESTER_IDENTITY_REF = "customer_agent_001";
export const TEST_MERCHANT_IDENTITY_REF = "merchant_agent_001";

export function make_liability_terms(): LiabilityTerms {
  return {
    liability_mode: "shared",
    merchant_responsibility: "Merchant provides the offered slot and fulfillment support.",
    requester_responsibility: "Requester provides an authorized booking request and accurate slot selection.",
    dispute_policy_ref: "merchant_policy_001",
  };
}

export function make_request(overrides: Partial<BookingRequest> = {}): BookingRequest {
  return {
    request_id: "request_001",
    idempotency_key: "request_op_001",
    requester_identity_ref: TEST_REQUESTER_IDENTITY_REF,
    expires_at_iso: TEST_EXPIRES_AT_ISO,
    policy_version: TEST_POLICY_VERSION,
    merchant_identity_ref: TEST_MERCHANT_IDENTITY_REF,
    vertical: "dental",
    liability_terms: make_liability_terms(),
    ...overrides,
  };
}

export function make_slot_offer(overrides: Partial<SlotOffer> = {}): SlotOffer {
  return {
    slot_offer_id: "slot_offer_001",
    idempotency_key: "offer_op_001",
    requester_identity_ref: TEST_REQUESTER_IDENTITY_REF,
    expires_at_iso: TEST_EXPIRES_AT_ISO,
    policy_version: TEST_POLICY_VERSION,
    merchant_identity_ref: TEST_MERCHANT_IDENTITY_REF,
    vertical: "dental",
    start_at_iso: "2026-09-24T10:30:00.000Z",
    end_at_iso: "2026-09-24T11:00:00.000Z",
    time_zone: "Asia/Jakarta",
    ...overrides,
  };
}

export function make_proposal(overrides: Partial<BookingProposal> = {}): BookingProposal {
  return {
    proposal_id: "proposal_001",
    request_id: "request_001",
    idempotency_key: "request_op_001",
    requester_identity_ref: TEST_REQUESTER_IDENTITY_REF,
    expires_at_iso: TEST_EXPIRES_AT_ISO,
    policy_version: TEST_POLICY_VERSION,
    merchant_identity_ref: TEST_MERCHANT_IDENTITY_REF,
    slot_offers: [make_slot_offer()],
    required_consent_scopes: ["discover_slots", "confirm_booking"],
    liability_terms: make_liability_terms(),
    ...overrides,
  };
}

export function make_consent(overrides: Partial<ConsentGrant> = {}): ConsentGrant {
  return {
    consent_id: "consent_001",
    request_id: "request_001",
    idempotency_key: "consent_op_001",
    requester_identity_ref: TEST_REQUESTER_IDENTITY_REF,
    expires_at_iso: TEST_EXPIRES_AT_ISO,
    policy_version: TEST_POLICY_VERSION,
    merchant_identity_ref: TEST_MERCHANT_IDENTITY_REF,
    granted_scopes: ["discover_slots", "confirm_booking"],
    granted_at_iso: TEST_NOW_ISO,
    liability_acknowledged: true,
    ...overrides,
  };
}
