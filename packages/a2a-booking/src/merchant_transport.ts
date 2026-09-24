import {
  CONSENT_SCOPES,
  is_opaque_identity_ref,
  type BookingConfirmation,
  type BookingProposal,
  type BookingRequest,
  type ConsentGrant,
  type ConsentScope,
  type LiabilityTerms,
  type SlotOffer,
} from "./booking_schema.js";
import type { ConfirmBookingInput, MerchantAgentTransport } from "./handshake.js";

/** Configuration for the deterministic in-memory transport mock. */
export interface InMemoryMerchantAgentOptions {
  /** Opaque merchant identity used in generated messages. */
  merchant_identity_ref: string;

  /** Slot offers available to the mock merchant. */
  slot_offers: readonly SlotOffer[];

  /** Liability terms copied into generated proposals. */
  liability_terms: LiabilityTerms;

  /** Injectable clock for deterministic confirmation timestamps. */
  clock?: () => string;
}

/** Domain error raised by the deterministic merchant transport. */
export class MerchantTransportError extends Error {
  /** Stable machine-readable error code. */
  readonly code = "merchant_transport_error";

  /**
   * Create a merchant transport error.
   *
   * @param reason - Safe reason without customer or secret data.
   */
  constructor(reason: string) {
    super(`Merchant transport rejected the request: ${reason}`);
    this.name = "MerchantTransportError";
  }
}

/** Deterministic transport mock that exercises the protocol without a network. */
export class InMemoryMerchantAgentTransport implements MerchantAgentTransport {
  private readonly merchant_identity_ref: string;
  private readonly slot_offers: readonly SlotOffer[];
  private readonly liability_terms: LiabilityTerms;
  private readonly clock: () => string;
  private readonly request_fingerprints = new Map<string, string>();
  private readonly proposal_by_idempotency_key = new Map<string, BookingProposal>();
  private readonly confirmation_fingerprints = new Map<string, string>();
  private readonly confirmation_by_idempotency_key = new Map<string, BookingConfirmation>();

  /**
   * Create an in-memory merchant.
   *
   * @param options - Deterministic merchant identity, offers, terms, and clock.
   * @throws MerchantTransportError when configuration is structurally invalid.
   */
  constructor(options: InMemoryMerchantAgentOptions) {
    assert_identity_ref(options.merchant_identity_ref, "merchant identity");
    if (!Array.isArray(options.slot_offers) || !is_valid_liability_terms(options.liability_terms)) {
      throw new MerchantTransportError("invalid merchant configuration");
    }
    this.merchant_identity_ref = options.merchant_identity_ref;
    this.slot_offers = [...options.slot_offers];
    this.liability_terms = options.liability_terms;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  /**
   * Return a cached proposal for a duplicate request or build one from offers.
   *
   * @param request - Request to answer.
   * @returns A deterministic proposal with the request's policy and expiry.
   * @throws MerchantTransportError for a key conflict or no matching offer.
   */
  async propose_slots(request: BookingRequest): Promise<BookingProposal> {
    assert_request_metadata(request);
    const fingerprint = idempotency_fingerprint(request);
    const cached_proposal = this.proposal_by_idempotency_key.get(request.idempotency_key);
    if (cached_proposal !== undefined) {
      if (this.request_fingerprints.get(request.idempotency_key) !== fingerprint) {
        throw new MerchantTransportError("idempotency key conflicts with an earlier request");
      }
      return cached_proposal;
    }
    if (request.merchant_identity_ref !== this.merchant_identity_ref) {
      throw new MerchantTransportError("request targets a different merchant");
    }
    const now_iso = this.read_clock();
    if (is_expired(request.expires_at_iso, now_iso)) {
      throw new MerchantTransportError("request has expired");
    }
    const offers = this.slot_offers.filter(
      (offer) =>
        is_valid_slot_offer(offer) &&
        offer.merchant_identity_ref === this.merchant_identity_ref &&
        offer.requester_identity_ref === request.requester_identity_ref &&
        offer.vertical === request.vertical &&
        offer.policy_version === request.policy_version &&
        Date.parse(offer.start_at_iso) > Date.parse(now_iso) &&
        !is_expired(offer.expires_at_iso, now_iso),
    );
    if (offers.length === 0) {
      throw new MerchantTransportError("no matching slot offers");
    }
    const proposal: BookingProposal = {
      proposal_id: `proposal_${request.request_id}`,
      request_id: request.request_id,
      idempotency_key: request.idempotency_key,
      requester_identity_ref: request.requester_identity_ref,
      expires_at_iso: request.expires_at_iso,
      policy_version: request.policy_version,
      merchant_identity_ref: this.merchant_identity_ref,
      slot_offers: offers.map((offer) => ({ ...offer })),
      required_consent_scopes: ["discover_slots", "confirm_booking"],
      liability_terms: this.liability_terms,
    };
    this.request_fingerprints.set(request.idempotency_key, fingerprint);
    this.proposal_by_idempotency_key.set(request.idempotency_key, proposal);
    return proposal;
  }

  /**
   * Confirm a selected offer and cache the result by idempotency key.
   *
   * @param input - Proposal, consent, selected offer, and confirmation key.
   * @returns The original result for an identical retry.
   * @throws MerchantTransportError for invalid references, expiry, or conflicts.
   */
  async confirm_booking(input: ConfirmBookingInput): Promise<BookingConfirmation> {
    assert_confirmation_input(input);
    const fingerprint = idempotency_fingerprint(input);
    const cached_confirmation = this.confirmation_by_idempotency_key.get(input.idempotency_key);
    if (cached_confirmation !== undefined) {
      if (this.confirmation_fingerprints.get(input.idempotency_key) !== fingerprint) {
        throw new MerchantTransportError("idempotency key conflicts with an earlier confirmation");
      }
      return cached_confirmation;
    }
    const selected_offer = input.proposal.slot_offers.find(
      (offer) => offer.slot_offer_id === input.selected_slot_offer_id,
    );
    if (selected_offer === undefined) {
      throw new MerchantTransportError("selected slot is not in the proposal");
    }
    const now_iso = this.read_clock();
    if (is_expired(input.proposal.expires_at_iso, now_iso) || is_expired(input.consent.expires_at_iso, now_iso)) {
      throw new MerchantTransportError("proposal or consent has expired");
    }
    if (input.proposal.merchant_identity_ref !== this.merchant_identity_ref) {
      throw new MerchantTransportError("proposal targets a different merchant");
    }
    if (Date.parse(input.consent.granted_at_iso) > Date.parse(now_iso)) {
      throw new MerchantTransportError("consent timestamp is in the future");
    }
    if (Date.parse(selected_offer.start_at_iso) <= Date.parse(now_iso)) {
      throw new MerchantTransportError("selected slot is in the past");
    }
    assert_same_reference("request_id", input.proposal.request_id, input.consent.request_id);
    assert_same_reference(
      "requester_identity_ref",
      input.proposal.requester_identity_ref,
      input.consent.requester_identity_ref,
    );
    assert_same_reference(
      "merchant_identity_ref",
      input.proposal.merchant_identity_ref,
      input.consent.merchant_identity_ref,
    );
    assert_same_reference("policy_version", input.proposal.policy_version, input.consent.policy_version);
    if (!input.consent.liability_acknowledged) {
      throw new MerchantTransportError("confirmation consent did not acknowledge liability");
    }
    const missing_scope = input.proposal.required_consent_scopes.find(
      (scope) => !input.consent.granted_scopes.includes(scope),
    );
    if (missing_scope !== undefined) {
      throw new MerchantTransportError("confirmation consent is missing a required scope");
    }
    assert_offer_matches_proposal(input.proposal, selected_offer);
    const confirmation: BookingConfirmation = {
      confirmation_id: `confirmation_${input.proposal.request_id}`,
      request_id: input.proposal.request_id,
      proposal_id: input.proposal.proposal_id,
      slot_offer_id: selected_offer.slot_offer_id,
      idempotency_key: input.idempotency_key,
      requester_identity_ref: input.proposal.requester_identity_ref,
      expires_at_iso: input.proposal.expires_at_iso,
      policy_version: input.proposal.policy_version,
      merchant_identity_ref: input.proposal.merchant_identity_ref,
      consent_id: input.consent.consent_id,
      booking_reference: `booking_${input.proposal.request_id}`,
      confirmed_at_iso: now_iso,
      liability_terms: input.proposal.liability_terms,
    };
    this.confirmation_fingerprints.set(input.idempotency_key, fingerprint);
    this.confirmation_by_idempotency_key.set(input.idempotency_key, confirmation);
    return confirmation;
  }

  private read_clock(): string {
    const now_iso = this.clock();
    if (!is_valid_timestamp(now_iso)) {
      throw new MerchantTransportError("clock returned an invalid timestamp");
    }
    return now_iso;
  }
}

function assert_request_metadata(request: BookingRequest): void {
  if (!is_record(request) || !is_text(request.request_id) || !is_text(request.idempotency_key) || !is_text(request.vertical)) {
    throw new MerchantTransportError("invalid request metadata");
  }
  assert_identity_ref(request.requester_identity_ref, "requester identity");
  assert_identity_ref(request.merchant_identity_ref, "merchant identity");
  if (!is_valid_timestamp(request.expires_at_iso) || !is_text(request.policy_version)) {
    throw new MerchantTransportError("invalid request policy metadata");
  }
}

function assert_confirmation_input(input: ConfirmBookingInput): void {
  if (
    !is_record(input) ||
    !is_record(input.proposal) ||
    !is_record(input.consent) ||
    !is_text(input.idempotency_key) ||
    !is_text(input.selected_slot_offer_id)
  ) {
    throw new MerchantTransportError("invalid confirmation metadata");
  }
  if (!is_valid_proposal(input.proposal) || !is_valid_consent(input.consent)) {
    throw new MerchantTransportError("invalid confirmation artifact");
  }
}

function is_valid_proposal(proposal: BookingProposal): boolean {
  return (
    is_text(proposal.proposal_id) &&
    is_text(proposal.request_id) &&
    is_text(proposal.idempotency_key) &&
    is_identity_ref(proposal.requester_identity_ref) &&
    is_identity_ref(proposal.merchant_identity_ref) &&
    is_text(proposal.policy_version) &&
    is_valid_timestamp(proposal.expires_at_iso) &&
    Array.isArray(proposal.slot_offers) &&
    proposal.slot_offers.length > 0 &&
    proposal.slot_offers.every((offer) => is_valid_slot_offer(offer)) &&
    Array.isArray(proposal.required_consent_scopes) &&
    proposal.required_consent_scopes.length > 0 &&
    proposal.required_consent_scopes.every((scope) => CONSENT_SCOPES.includes(scope as ConsentScope)) &&
    new Set(proposal.required_consent_scopes).size === proposal.required_consent_scopes.length &&
    is_valid_liability_terms(proposal.liability_terms)
  );
}

function is_valid_consent(consent: ConsentGrant): boolean {
  return (
    is_text(consent.consent_id) &&
    is_text(consent.request_id) &&
    is_text(consent.idempotency_key) &&
    is_identity_ref(consent.requester_identity_ref) &&
    is_identity_ref(consent.merchant_identity_ref) &&
    is_text(consent.policy_version) &&
    is_valid_timestamp(consent.expires_at_iso) &&
    is_valid_timestamp(consent.granted_at_iso) &&
    typeof consent.liability_acknowledged === "boolean" &&
    Array.isArray(consent.granted_scopes) &&
    consent.granted_scopes.every((scope) => CONSENT_SCOPES.includes(scope as ConsentScope)) &&
    new Set(consent.granted_scopes).size === consent.granted_scopes.length
  );
}

function is_valid_slot_offer(offer: SlotOffer): boolean {
  return (
    is_text(offer.slot_offer_id) &&
    is_text(offer.idempotency_key) &&
    is_identity_ref(offer.requester_identity_ref) &&
    is_identity_ref(offer.merchant_identity_ref) &&
    is_text(offer.vertical) &&
    is_valid_timestamp(offer.expires_at_iso) &&
    is_valid_timestamp(offer.start_at_iso) &&
    is_valid_timestamp(offer.end_at_iso) &&
    Date.parse(offer.end_at_iso) > Date.parse(offer.start_at_iso) &&
    is_text(offer.time_zone)
  );
}

function assert_offer_matches_proposal(proposal: BookingProposal, offer: SlotOffer): void {
  assert_same_reference("requester_identity_ref", proposal.requester_identity_ref, offer.requester_identity_ref);
  assert_same_reference("merchant_identity_ref", proposal.merchant_identity_ref, offer.merchant_identity_ref);
  assert_same_reference("policy_version", proposal.policy_version, offer.policy_version);
}

function is_valid_liability_terms(value: LiabilityTerms): boolean {
  return (
    is_record(value) &&
    ["merchant", "requester", "shared"].includes(value.liability_mode) &&
    is_text(value.merchant_responsibility) &&
    is_text(value.requester_responsibility) &&
    is_text(value.dispute_policy_ref)
  );
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function is_text(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 4096;
}

function is_identity_ref(value: unknown): value is string {
  return typeof value === "string" && is_opaque_identity_ref(value);
}

function assert_identity_ref(value: string, field_name: string): void {
  if (!is_identity_ref(value)) {
    throw new MerchantTransportError(`${field_name} is not an opaque reference`);
  }
}

function is_valid_timestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T/.test(value) &&
    value.trim() === value &&
    Number.isFinite(Date.parse(value))
  );
}

function is_expired(expires_at_iso: string, now_iso: string): boolean {
  return Date.parse(expires_at_iso) <= Date.parse(now_iso);
}

function assert_same_reference(field_name: string, expected: string, actual: string): void {
  if (expected !== actual) {
    throw new MerchantTransportError(`${field_name} does not match`);
  }
}

function idempotency_fingerprint(value: unknown): string {
  try {
    return JSON.stringify(canonicalize(value));
  } catch {
    throw new MerchantTransportError("idempotency payload cannot be serialized");
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (is_record(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}
