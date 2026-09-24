import {
  CONSENT_SCOPES,
  is_opaque_identity_ref,
  type BookingConfirmation,
  type BookingProposal,
  type BookingRequest,
  type ConsentGrant,
  type ConsentScope,
  type SlotOffer,
} from "./booking_schema.js";

/** Ordered legal states for the merchant handshake. */
export const HANDSHAKE_STATES = [
  "initiated",
  "counterparty_offered",
  "consent_requested",
  "consent_granted",
  "confirmed",
  "rejected",
  "expired",
] as const;

/** A state in the merchant handshake lifecycle. */
export type HandshakeState = (typeof HANDSHAKE_STATES)[number];

/** Pure state-machine events accepted by the handshake. */
export type HandshakeEventType =
  | "offer_slots"
  | "request_consent"
  | "grant_consent"
  | "confirm_booking"
  | "reject"
  | "expire";

/**
 * State labels accepted by the pure state helper as transition signals.
 *
 * @remarks Action names are preferred for protocol code; state labels make
 * persistence and UI state adapters less dependent on action vocabulary.
 */
export type HandshakeSignal =
  | HandshakeEventType
  | "initiated"
  | "counterparty_offered"
  | "consent_requested"
  | "consent_granted"
  | "confirmed"
  | "rejected"
  | "expired";

/** A payload-bearing event that advances a handshake session. */
export type HandshakeEvent =
  | { type: "offer_slots"; proposal: BookingProposal }
  | { type: "request_consent"; required_scopes: ConsentScope[] }
  | { type: "grant_consent"; consent: ConsentGrant }
  | { type: "confirm_booking"; confirmation: BookingConfirmation }
  | { type: "reject"; reason: string }
  | { type: "expire"; reason?: string };

/** Immutable state and data owned by one handshake. */
export interface HandshakeSession {
  /** Current state. */
  readonly state: HandshakeState;

  /** Initial request that anchors the exchange. */
  readonly request: BookingRequest;

  /** Merchant proposal, once offered. */
  readonly proposal?: BookingProposal;

  /** Scopes that the customer must grant before confirmation. */
  readonly required_consent_scopes: readonly ConsentScope[];

  /** Consent grant, once granted. */
  readonly consent?: ConsentGrant;

  /** Final confirmation, once committed. */
  readonly confirmation?: BookingConfirmation;

  /** Safe explanation for a terminal rejection or expiry. */
  readonly terminal_reason?: string;
}

/**
 * Error raised when an event is not legal from the current state.
 */
export class IllegalHandshakeTransitionError extends Error {
  /** Stable machine-readable error code. */
  readonly code = "illegal_handshake_transition";

  /**
   * Create an illegal-transition error.
   *
   * @param current_state - State from which the event was attempted.
   * @param event_type - Event that was attempted.
   */
  constructor(
    readonly current_state: HandshakeState,
    readonly event_type: HandshakeSignal,
  ) {
    super(`Cannot apply handshake event '${event_type}' from state '${current_state}'.`);
    this.name = "IllegalHandshakeTransitionError";
  }
}

/**
 * Error raised when a legal event carries mismatched booking references.
 */
export class HandshakePayloadError extends Error {
  /** Stable machine-readable error code. */
  readonly code = "invalid_handshake_payload";

  /**
   * Create a payload error.
   *
   * @param reason - Safe reason that does not include personal data.
   */
  constructor(reason: string) {
    super(`Invalid handshake payload: ${reason}`);
    this.name = "HandshakePayloadError";
  }
}

/** Input required from a customer agent to commit a proposed slot. */
export interface ConfirmBookingInput {
  /** Proposal containing the offered slot. */
  proposal: BookingProposal;

  /** Consent grant authorizing confirmation. */
  consent: ConsentGrant;

  /** Selected offer identifier from the proposal. */
  selected_slot_offer_id: string;

  /** Stable key for retries of this confirmation. */
  idempotency_key: string;
}

/** Transport port for a future A2A adapter; this package has no network implementation. */
export interface MerchantAgentTransport {
  /**
   * Request a proposal from a merchant agent.
   *
   * @param request - Validated booking request.
   * @returns A merchant proposal.
   */
  propose_slots(request: BookingRequest): Promise<BookingProposal>;

  /**
   * Confirm one selected proposed slot.
   *
   * @param input - Proposal, consent, selection, and retry key.
   * @returns A merchant confirmation.
   */
  confirm_booking(input: ConfirmBookingInput): Promise<BookingConfirmation>;
}

export { InMemoryMerchantAgentTransport, MerchantTransportError } from "./merchant_transport.js";

const transitions: Record<HandshakeState, Partial<Record<HandshakeEventType, HandshakeState>>> = {
  initiated: {
    offer_slots: "counterparty_offered",
    reject: "rejected",
    expire: "expired",
  },
  counterparty_offered: {
    request_consent: "consent_requested",
    reject: "rejected",
    expire: "expired",
  },
  consent_requested: {
    grant_consent: "consent_granted",
    reject: "rejected",
    expire: "expired",
  },
  consent_granted: {
    confirm_booking: "confirmed",
    reject: "rejected",
    expire: "expired",
  },
  confirmed: {},
  rejected: {},
  expired: {},
};

/**
 * Transition a handshake state without mutating the input.
 *
 * @param current_state - State before the event.
 * @param event_type - Event to apply.
 * @returns The next state.
 * @throws IllegalHandshakeTransitionError when the event is not legal.
 */
export function transition_handshake(
  current_state: HandshakeState,
  event_type: HandshakeSignal,
): HandshakeState {
  if (!is_handshake_state(current_state) || !is_handshake_signal(event_type)) {
    throw new IllegalHandshakeTransitionError(current_state, event_type);
  }
  const normalized_event = normalize_signal(event_type);
  if (normalized_event === undefined) {
    throw new IllegalHandshakeTransitionError(current_state, event_type);
  }
  const next_state = transitions[current_state][normalized_event];
  if (next_state === undefined) {
    throw new IllegalHandshakeTransitionError(current_state, event_type);
  }
  return next_state;
}

/**
 * Create the initial immutable handshake session.
 *
 * @param request - Request anchoring the session.
 * @returns A session in the initiated state without any network side effect.
 */
export function initiate_handshake(request: BookingRequest): HandshakeSession {
  return {
    state: "initiated",
    request,
    required_consent_scopes: [],
  };
}

/**
 * Apply a payload-bearing event and return a new session.
 *
 * @param session - Current session; it is not mutated.
 * @param event - Event to apply.
 * @returns A new session after the event.
 * @throws IllegalHandshakeTransitionError for an illegal state transition.
 * @throws HandshakePayloadError for mismatched or incomplete references.
 */
export function apply_handshake_event(
  session: HandshakeSession,
  event: HandshakeEvent,
): HandshakeSession {
  const next_state = transition_handshake(session.state, event.type);
  return { ...session, ...apply_event_payload(session, event), state: next_state };
}

function apply_event_payload(
  session: HandshakeSession,
  event: HandshakeEvent,
): Partial<HandshakeSession> {
  switch (event.type) {
    case "offer_slots":
      assert_proposal_matches_request(session.request, event.proposal);
      return { proposal: event.proposal };
    case "request_consent":
      if (
        event.required_scopes.length === 0 ||
        !event.required_scopes.every((scope) => CONSENT_SCOPES.includes(scope)) ||
        new Set(event.required_scopes).size !== event.required_scopes.length
      ) {
        throw new HandshakePayloadError("consent scopes are invalid");
      }
      return { required_consent_scopes: [...event.required_scopes] };
    case "grant_consent":
      assert_consent_matches_request(session, event.consent);
      return { consent: event.consent };
    case "confirm_booking":
      assert_confirmation_matches_session(session, event.confirmation);
      return { confirmation: event.confirmation };
    case "reject":
      return { terminal_reason: safe_reason(event.reason, "handshake_rejected") };
    case "expire":
      return { terminal_reason: safe_reason(event.reason ?? undefined, "handshake_expired") };
  }
}

function assert_proposal_matches_request(request: BookingRequest, proposal: BookingProposal): void {
  if (!is_record(request) || !is_record(proposal)) {
    throw new HandshakePayloadError("proposal or request is not an object");
  }
  assert_same_value("request_id", request.request_id, proposal.request_id);
  assert_same_identity_ref("requester_identity_ref", request.requester_identity_ref, proposal.requester_identity_ref);
  assert_same_value("policy_version", request.policy_version, proposal.policy_version);
  if (
    !Array.isArray(proposal.slot_offers) ||
    proposal.slot_offers.length === 0 ||
    !proposal.slot_offers.every((offer) => is_valid_offer_reference(offer, request))
  ) {
    throw new HandshakePayloadError("proposal must contain valid slot offers");
  }
}

function assert_consent_matches_request(session: HandshakeSession, consent: ConsentGrant): void {
  if (!is_record(consent)) {
    throw new HandshakePayloadError("consent is not an object");
  }
  if (session.proposal === undefined) {
    throw new HandshakePayloadError("consent cannot precede a proposal");
  }
  assert_same_value("request_id", session.request.request_id, consent.request_id);
  assert_same_identity_ref(
    "requester_identity_ref",
    session.request.requester_identity_ref,
    consent.requester_identity_ref,
  );
  assert_same_identity_ref("merchant_identity_ref", session.proposal.merchant_identity_ref, consent.merchant_identity_ref);
  assert_same_value("policy_version", session.request.policy_version, consent.policy_version);
  if (!consent.liability_acknowledged) {
    throw new HandshakePayloadError("liability terms were not acknowledged");
  }
  if (
    !Array.isArray(consent.granted_scopes) ||
    !consent.granted_scopes.every((scope) => CONSENT_SCOPES.includes(scope)) ||
    new Set(consent.granted_scopes).size !== consent.granted_scopes.length
  ) {
    throw new HandshakePayloadError("consent scopes are invalid");
  }
  const required_scopes = session.required_consent_scopes;
  if (!required_scopes.every((scope) => consent.granted_scopes.includes(scope))) {
    throw new HandshakePayloadError("consent does not cover all required scopes");
  }
}

function assert_confirmation_matches_session(
  session: HandshakeSession,
  confirmation: BookingConfirmation,
): void {
  if (!is_record(confirmation)) {
    throw new HandshakePayloadError("confirmation is not an object");
  }
  if (session.proposal === undefined || session.consent === undefined) {
    throw new HandshakePayloadError("confirmation requires a proposal and consent");
  }
  assert_same_value("request_id", session.request.request_id, confirmation.request_id);
  assert_same_value("proposal_id", session.proposal.proposal_id, confirmation.proposal_id);
  assert_same_value("consent_id", session.consent.consent_id, confirmation.consent_id);
  assert_same_identity_ref(
    "requester_identity_ref",
    session.request.requester_identity_ref,
    confirmation.requester_identity_ref,
  );
  assert_same_value("policy_version", session.request.policy_version, confirmation.policy_version);
  if (!session.proposal.slot_offers.some((offer) => offer.slot_offer_id === confirmation.slot_offer_id)) {
    throw new HandshakePayloadError("selected slot is not present in the proposal");
  }
}

function is_valid_offer_reference(offer: SlotOffer, request: BookingRequest): boolean {
  if (!is_record(offer) || !is_record(request)) {
    return false;
  }
  return (
    is_text(offer.slot_offer_id) &&
    is_text(offer.vertical) &&
    is_opaque_identity_ref(offer.requester_identity_ref) &&
    is_opaque_identity_ref(offer.merchant_identity_ref) &&
    offer.requester_identity_ref === request.requester_identity_ref &&
    offer.merchant_identity_ref === request.merchant_identity_ref &&
    offer.policy_version === request.policy_version &&
    is_valid_timestamp(offer.start_at_iso) &&
    is_valid_timestamp(offer.end_at_iso) &&
    Date.parse(offer.end_at_iso) > Date.parse(offer.start_at_iso)
  );
}

function assert_same_value(field_name: string, expected: string, actual: string): void {
  if (!is_text(expected) || !is_text(actual) || expected !== actual) {
    throw new HandshakePayloadError(`${field_name} does not match`);
  }
}

function assert_same_identity_ref(field_name: string, expected: string, actual: string): void {
  if (!is_text(expected) || !is_text(actual) || !is_opaque_identity_ref(expected) || !is_opaque_identity_ref(actual) || expected !== actual) {
    throw new HandshakePayloadError(`${field_name} does not match`);
  }
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function is_text(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 4096;
}

function is_valid_timestamp(value: unknown): value is string {
  return is_text(value) && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}

function safe_reason(reason: string | undefined, fallback: string): string {
  if (typeof reason !== "string") {
    return fallback;
  }
  const normalized_reason = reason.trim();
  return normalized_reason !== undefined && /^[a-z0-9_:-]{1,64}$/.test(normalized_reason)
    ? normalized_reason
    : fallback;
}

function is_handshake_state(value: unknown): value is HandshakeState {
  return HANDSHAKE_STATES.includes(value as HandshakeState);
}

function is_handshake_signal(value: unknown): value is HandshakeSignal {
  return [
    "offer_slots",
    "request_consent",
    "grant_consent",
    "confirm_booking",
    "reject",
    "expire",
    "initiated",
    "counterparty_offered",
    "consent_requested",
    "consent_granted",
    "confirmed",
    "rejected",
    "expired",
  ].includes(value as HandshakeSignal);
}

function normalize_signal(signal: HandshakeSignal): HandshakeEventType | undefined {
  switch (signal) {
    case "offer_slots":
    case "counterparty_offered":
      return "offer_slots";
    case "request_consent":
    case "consent_requested":
      return "request_consent";
    case "grant_consent":
    case "consent_granted":
      return "grant_consent";
    case "confirm_booking":
    case "confirmed":
      return "confirm_booking";
    case "reject":
    case "rejected":
      return "reject";
    case "expire":
    case "expired":
      return "expire";
    case "initiated":
      return undefined;
  }
}

