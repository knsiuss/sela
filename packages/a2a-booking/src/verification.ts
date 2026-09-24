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

/** Booking messages that can cross the incoming verification boundary. */
export type VerifiableBooking = BookingRequest | BookingProposal | BookingConfirmation;

/** Stable reasons returned when an incoming booking is rejected. */
export type VerificationRejectionReason =
  | "invalid_context"
  | "invalid_payload"
  | "missing_consent"
  | "invalid_consent"
  | "consent_expired"
  | "consent_policy_mismatch"
  | "consent_identity_mismatch"
  | "consent_scope_missing"
  | "idempotency_store_unavailable"
  | "idempotency_duplicate"
  | "expired"
  | "policy_version_mismatch";

/** Boundary context needed to verify an incoming booking safely. */
export interface BookingVerificationContext {
  /** Exact policy version expected by the local merchant. */
  expected_policy_version: string;

  /** Keys already durably accepted by the receiving side. */
  seen_idempotency_keys: ReadonlySet<string>;

  /** Optional deterministic clock value; defaults to the current epoch. */
  now_epoch_ms?: number;

  /** Consent grant that authorizes the incoming booking. */
  consent_grant?: ConsentGrant;
}

/** Fail-closed result returned for an incoming booking artifact. */
export interface BookingVerificationResult {
  /** Whether the artifact is safe to pass to the next protocol layer. */
  is_verified: boolean;

  /** Stable rejection reason; absent when verification succeeds. */
  reason?: VerificationRejectionReason;

  /** Safe diagnostic message that does not contain submitted values. */
  message: string;
}

/**
 * Verify an incoming booking artifact and its consent binding.
 *
 * @param booking - Untrusted JSON value received from another agent.
 * @param context - Expected policy, idempotency store, clock, and consent.
 * @returns A verification result; malformed or ambiguous input is rejected.
 */
export function verify_booking(
  booking: unknown,
  context: BookingVerificationContext,
): BookingVerificationResult {
  if (!is_verification_context(context)) {
    const reason: VerificationRejectionReason = has_missing_idempotency_store(context)
      ? "idempotency_store_unavailable"
      : "invalid_context";
    return rejected(reason, "Verification context is incomplete.");
  }
  if (!is_verifiable_booking(booking)) {
    return rejected("invalid_payload", "Booking payload is not a supported booking artifact.");
  }
  if (booking.policy_version !== context.expected_policy_version) {
    return rejected("policy_version_mismatch", "Booking policy version is not supported.");
  }
  const now_epoch_ms = context.now_epoch_ms ?? Date.now();
  if (Date.parse(booking.expires_at_iso) <= now_epoch_ms || has_expired_slot_offer(booking, now_epoch_ms)) {
    return rejected("expired", "Booking artifact has expired.");
  }
  if (context.seen_idempotency_keys.has(booking.idempotency_key)) {
    return rejected("idempotency_duplicate", "Booking idempotency key was already accepted.");
  }
  if (context.consent_grant === undefined) {
    return rejected("missing_consent", "Booking has no consent grant.");
  }
  return verify_consent(context.consent_grant, booking, context.expected_policy_version, now_epoch_ms);
}

/**
 * Alias with a transport-oriented name for callers at an incoming boundary.
 *
 * @param booking - Untrusted incoming booking value.
 * @param context - Verification dependencies and expected policy.
 * @returns A fail-closed verification result.
 */
export function verify_incoming_booking(
  booking: unknown,
  context: BookingVerificationContext,
): BookingVerificationResult {
  return verify_booking(booking, context);
}

function verify_consent(
  consent: unknown,
  booking: VerifiableBooking,
  expected_policy_version: string,
  now_epoch_ms: number,
): BookingVerificationResult {
  if (!is_consent_grant(consent)) {
    return rejected("invalid_consent", "Consent grant is malformed.");
  }
  if (consent.policy_version !== expected_policy_version || consent.policy_version !== booking.policy_version) {
    return rejected("consent_policy_mismatch", "Consent policy version does not match.");
  }
  if (
    consent.request_id !== booking.request_id ||
    consent.requester_identity_ref !== booking.requester_identity_ref ||
    consent.merchant_identity_ref !== booking.merchant_identity_ref
  ) {
    return rejected("consent_identity_mismatch", "Consent is not bound to this booking.");
  }
  if (Date.parse(consent.expires_at_iso) <= now_epoch_ms) {
    return rejected("consent_expired", "Consent grant has expired.");
  }
  if (Date.parse(consent.granted_at_iso) > now_epoch_ms) {
    return rejected("invalid_consent", "Consent timestamp is in the future.");
  }
  if (!consent.liability_acknowledged) {
    return rejected("invalid_consent", "Consent did not acknowledge liability terms.");
  }
  if (!required_consent_scopes(booking).every((scope) => consent.granted_scopes.includes(scope))) {
    return rejected("consent_scope_missing", "Consent does not cover the required scope.");
  }
  return accepted();
}

function has_missing_idempotency_store(value: unknown): boolean {
  return is_record(value) && value.seen_idempotency_keys === undefined;
}

function is_verification_context(value: unknown): value is BookingVerificationContext {
  if (!is_record(value) || !is_text(value.expected_policy_version)) {
    return false;
  }
  if (value.now_epoch_ms !== undefined && !is_finite_number(value.now_epoch_ms)) {
    return false;
  }
  if (!is_set_like(value.seen_idempotency_keys)) {
    return false;
  }
  return value.consent_grant === undefined || is_record(value.consent_grant);
}

function is_verifiable_booking(value: unknown): value is VerifiableBooking {
  if (!is_record(value) || !has_common_protocol_fields(value) || !is_valid_liability_terms(value.liability_terms)) {
    return false;
  }
  if ("slot_offers" in value) {
    return is_booking_proposal(value);
  }
  if ("confirmation_id" in value) {
    return is_booking_confirmation(value);
  }
  return is_booking_request(value);
}

function is_booking_request(value: Record<string, unknown>): boolean {
  return (
    is_text(value.request_id) &&
    is_identity_ref(value.merchant_identity_ref) &&
    is_text(value.vertical) &&
    (value.preferred_start_at_iso === undefined || is_timestamp(value.preferred_start_at_iso)) &&
    (value.preferred_end_at_iso === undefined || is_timestamp(value.preferred_end_at_iso))
  );
}

function is_booking_proposal(value: Record<string, unknown>): boolean {
  if (
    !is_text(value.proposal_id) ||
    !is_text(value.request_id) ||
    !is_identity_ref(value.requester_identity_ref) ||
    !is_identity_ref(value.merchant_identity_ref) ||
    !Array.isArray(value.slot_offers) ||
    value.slot_offers.length === 0 ||
    !value.slot_offers.every((offer) => is_slot_offer(offer)) ||
    !is_scope_list(value.required_consent_scopes) ||
    value.required_consent_scopes.length === 0
  ) {
    return false;
  }
  const slot_offers = value.slot_offers as SlotOffer[];
  return slot_offers.every(
    (offer) =>
      offer.requester_identity_ref === value.requester_identity_ref &&
      offer.merchant_identity_ref === value.merchant_identity_ref &&
      offer.policy_version === value.policy_version,
  );
}

function is_booking_confirmation(value: Record<string, unknown>): boolean {
  return (
    is_text(value.confirmation_id) &&
    is_text(value.request_id) &&
    is_text(value.proposal_id) &&
    is_text(value.slot_offer_id) &&
    is_identity_ref(value.merchant_identity_ref) &&
    is_text(value.consent_id) &&
    is_text(value.booking_reference) &&
    is_timestamp(value.confirmed_at_iso)
  );
}

function is_slot_offer(value: unknown): value is SlotOffer {
  if (!is_record(value) || !has_common_protocol_fields(value)) {
    return false;
  }
  return (
    is_text(value.slot_offer_id) &&
    is_identity_ref(value.merchant_identity_ref) &&
    is_text(value.vertical) &&
    is_timestamp(value.start_at_iso) &&
    is_timestamp(value.end_at_iso) &&
    Date.parse(value.end_at_iso) > Date.parse(value.start_at_iso) &&
    is_text(value.time_zone)
  );
}

function is_consent_grant(value: unknown): value is ConsentGrant {
  if (!is_record(value) || !has_common_protocol_fields(value)) {
    return false;
  }
  return (
    is_text(value.consent_id) &&
    is_text(value.request_id) &&
    is_identity_ref(value.merchant_identity_ref) &&
    is_scope_list(value.granted_scopes) &&
    is_timestamp(value.granted_at_iso) &&
    typeof value.liability_acknowledged === "boolean"
  );
}

function has_common_protocol_fields(value: Record<string, unknown>): boolean {
  return (
    is_text(value.idempotency_key) &&
    is_identity_ref(value.requester_identity_ref) &&
    is_timestamp(value.expires_at_iso) &&
    is_text(value.policy_version)
  );
}

function is_valid_liability_terms(value: unknown): value is LiabilityTerms {
  return (
    is_record(value) &&
    ["merchant", "requester", "shared"].includes(value.liability_mode as string) &&
    is_text(value.merchant_responsibility) &&
    is_text(value.requester_responsibility) &&
    is_text(value.dispute_policy_ref)
  );
}

function is_scope_list(value: unknown): value is ConsentScope[] {
  return (
    Array.isArray(value) &&
    value.every((scope) => CONSENT_SCOPES.includes(scope as ConsentScope)) &&
    new Set(value).size === value.length
  );
}

function has_expired_slot_offer(booking: VerifiableBooking, now_epoch_ms: number): boolean {
  return "slot_offers" in booking && booking.slot_offers.some((offer) => Date.parse(offer.expires_at_iso) <= now_epoch_ms);
}

function required_consent_scopes(booking: VerifiableBooking): ConsentScope[] {
  if ("required_consent_scopes" in booking) {
    return booking.required_consent_scopes;
  }
  if ("confirmation_id" in booking) {
    return ["confirm_booking"];
  }
  return ["discover_slots"];
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function is_set_like(value: unknown): value is ReadonlySet<string> {
  return value instanceof Set;
}

function is_text(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 4096;
}

function is_identity_ref(value: unknown): value is string {
  return typeof value === "string" && is_opaque_identity_ref(value);
}

function is_timestamp(value: unknown): value is string {
  return is_text(value) && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}

function is_finite_number(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function accepted(): BookingVerificationResult {
  return { is_verified: true, message: "Booking verification passed." };
}

function rejected(reason: VerificationRejectionReason, message: string): BookingVerificationResult {
  return { is_verified: false, reason, message };
}
