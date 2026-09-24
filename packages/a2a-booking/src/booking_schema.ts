/**
 * JSON-schema-friendly contracts for the roadmap A2A merchant handshake.
 *
 * The contracts intentionally contain only JSON primitives, arrays, and objects.
 * They do not define A2A appointment semantics; they fill that application-layer
 * gap until a broader standard or working-group proposal exists.
 */

/** Default policy identifier used by the roadmap pilot examples. */
export const DEFAULT_BOOKING_POLICY_VERSION = "2026-09-roadmap-v1" as const;

/** Actions that a merchant can advertise in an A2A booking card. */
export const SUPPORTED_ACTIONS = ["propose_slots", "confirm_booking", "cancel_booking"] as const;

/** Type of an advertised merchant action. */
export type SupportedAction = (typeof SUPPORTED_ACTIONS)[number];

/** Closed consent vocabulary used by the minimal handshake. */
export const CONSENT_SCOPES = ["discover_slots", "confirm_booking", "cancel_booking"] as const;

/** Type of a consent scope understood by this policy version. */
export type ConsentScope = (typeof CONSENT_SCOPES)[number];

/** JSON primitive values that are safe to put in a serialized contract. */
export type JsonPrimitive = string | number | boolean | null;

/** JSON object values that are safe to put in a serialized contract. */
export interface JsonObject {
  [key: string]: JsonValue;
}

/** Recursive JSON value type used for schema-friendly metadata. */
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

/**
 * Protocol metadata carried by every booking artifact.
 *
 * The same four fields deliberately appear on requests, proposals, and
 * confirmations so that a later transport or persistence adapter can enforce
 * the same policy at every boundary without inventing a second envelope.
 */
export interface BookingProtocolFields {
  /**
   * Stable key for one logical operation and its retry.
   *
   * @remarks Reusing a key with the same operation may return the prior result;
   * reusing it for different input must be rejected by an adapter.
   */
  idempotency_key: string;

  /**
   * Opaque reference to the requesting customer agent or identity domain.
   *
   * @remarks Do not put names, phone numbers, email addresses, or other raw
   * PII in this field. Resolution and authentication belong outside this
   * schema layer.
   */
  requester_identity_ref: string;

  /**
   * ISO-8601 instant after which the artifact must not be acted upon.
   *
   * @remarks A short expiry limits replay of an otherwise valid proposal or
   * consent grant.
   */
  expires_at_iso: string;

  /**
   * Identifier of the policy used to interpret this artifact.
   *
   * @remarks Exact matching prevents a message from silently crossing policy
   * versions with different consent or liability rules.
   */
  policy_version: string;
}

/**
 * Explicit allocation of responsibility for a booking attempt.
 *
 * This is a protocol disclosure, not legal advice or a substitute for the
 * merchant's published terms. Both parties can record the same terms in a
 * request, proposal, and confirmation.
 */
export interface LiabilityTerms {
  /**
   * Whether the merchant, requester, or both are the primary liable party.
   *
   * @remarks The value makes the allocation visible before confirmation rather
   * than leaving responsibility implicit in an agent implementation.
   */
  liability_mode: "merchant" | "requester" | "shared";

  /**
   * Plain-language statement of the merchant's booking obligations.
   *
   * @remarks The text is deliberately open so verticals can describe slot
   * availability, fulfillment, and support responsibilities without changing
   * the wire shape.
   */
  merchant_responsibility: string;

  /**
   * Plain-language statement of the requester's booking obligations.
   *
   * @remarks The text can cover accuracy, authorization, payment, or other
   * customer-controlled duties without storing raw personal data.
   */
  requester_responsibility: string;

  /**
   * Stable reference to the dispute or escalation policy used by the merchant.
   *
   * @remarks A reference keeps the protocol auditable while allowing the
   * detailed policy to be maintained separately.
   */
  dispute_policy_ref: string;
}

/**
 * A consent requirement advertised by a merchant or included in a proposal.
 */
export interface ConsentRequirement {
  /**
   * Operation for which the customer agent is granting permission.
   *
   * @remarks The scope is explicit so consent cannot be silently generalized
   * from slot discovery to confirmation or cancellation.
   */
  scope: ConsentScope;

  /**
   * Human-readable purpose shown to the consenting principal or its agent.
   *
   * @remarks The purpose is a disclosure field, not a privacy-free substitute
   * for the merchant's consent notice.
   */
  purpose: string;

  /**
   * Whether the scope must be granted before the action can proceed.
   *
   * @remarks At least one required scope is needed for a useful booking card;
   * optional scopes must never be treated as authorization.
   */
  required: boolean;
}

/**
 * A bounded time slot offered by a merchant.
 */
export interface SlotOffer extends BookingProtocolFields {
  /**
   * Stable merchant-side identifier for this offered slot.
   *
   * @remarks It is an opaque booking-system reference, not a customer record
   * or calendar account.
   */
  slot_offer_id: string;

  /**
   * Opaque reference to the merchant agent offering the slot.
   *
   * @remarks The reference routes the eventual confirmation without carrying
   * merchant contact details.
   */
  merchant_identity_ref: string;

  /**
   * Vertical for which the slot is valid.
   *
   * @remarks Keeping the vertical on the offer prevents a proposal from being
   * replayed into a different appointment domain.
   */
  vertical: string;

  /**
   * ISO-8601 start instant of the slot.
   *
   * @remarks Consumers must normalize the slot into the displayed time zone
   * before asking for confirmation.
   */
  start_at_iso: string;

  /**
   * ISO-8601 end instant of the slot.
   *
   * @remarks The end instant makes duration validation explicit and avoids
   * relying on a local-time interpretation.
   */
  end_at_iso: string;

  /**
   * IANA time-zone identifier in which the slot should be displayed.
   *
   * @remarks The instant fields remain authoritative; the zone is a display
   * and policy context for humans and agents.
   */
  time_zone: string;
}

/**
 * Initial request from a customer agent to a merchant agent.
 */
export interface BookingRequest extends BookingProtocolFields {
  /**
   * Stable request identifier used to correlate the handshake.
   *
   * @remarks Correlation is necessary because transport messages may be
   * retried or delivered asynchronously.
   */
  request_id: string;

  /**
   * Opaque merchant-agent reference selected by the customer agent.
   *
   * @remarks The reference avoids putting merchant account or contact details
   * into the booking payload.
   */
  merchant_identity_ref: string;

  /**
   * Appointment vertical requested by the customer agent.
   *
   * @remarks The merchant can reject unsupported verticals before proposing
   * slots, preserving a clear discovery boundary.
   */
  vertical: string;

  /**
   * Optional earliest preferred start instant.
   *
   * @remarks Preferences are not a hold or confirmation; the merchant still
   * has to return an explicit slot offer.
   */
  preferred_start_at_iso?: string;

  /**
   * Optional latest preferred start instant.
   *
   * @remarks A preference is advisory and must never be interpreted as consent
   * or as a durable booking.
   */
  preferred_end_at_iso?: string;

  /**
   * Liability terms acknowledged as the starting point for the exchange.
   *
   * @remarks Repeating the terms in later artifacts prevents a merchant from
   * changing the allocation without an observable version boundary.
   */
  liability_terms: LiabilityTerms;
}

/**
 * Merchant response containing one or more offered slots and consent needs.
 */
export interface BookingProposal extends BookingProtocolFields {
  /**
   * Stable merchant-side proposal identifier.
   *
   * @remarks It ties a selected slot to the exact offer that was consented to.
   */
  proposal_id: string;

  /**
   * Request identifier this proposal answers.
   *
   * @remarks Cross-checking this reference prevents a proposal from being
   * substituted into another request.
   */
  request_id: string;

  /**
   * Opaque reference to the merchant agent that owns the offers.
   *
   * @remarks The reference lets the customer agent route the confirmation to
   * the same counterparty that produced the proposal.
   */
  merchant_identity_ref: string;

  /**
   * Slots that are valid for this proposal at issuance time.
   *
   * @remarks An offer is still subject to expiry and merchant-side availability
   * checks; it is not a confirmed appointment.
   */
  slot_offers: SlotOffer[];

  /**
   * Consent scopes that must be granted before selecting a slot.
   *
   * @remarks The list is copied into the consent decision so the customer can
   * see exactly what the proposal asks for.
   */
  required_consent_scopes: ConsentScope[];

  /**
   * Liability terms associated with the proposed booking.
   *
   * @remarks The terms are carried forward to confirmation for an auditable
   * allocation record.
   */
  liability_terms: LiabilityTerms;
}

/**
 * Evidence that a customer agent or its principal granted scoped consent.
 */
export interface ConsentGrant extends BookingProtocolFields {
  /**
   * Stable identifier for this consent decision.
   *
   * @remarks The identifier is an audit correlation key, not a biometric or
   * identity credential.
   */
  consent_id: string;

  /**
   * Request identifier to which the grant applies.
   *
   * @remarks Binding consent to one request prevents a broad grant from being
   * reused silently for another booking.
   */
  request_id: string;

  /**
   * Opaque merchant reference that is allowed to consume the grant.
   *
   * @remarks This recipient binding limits replay across merchant agents.
   */
  merchant_identity_ref: string;

  /**
   * Specific scopes the requester granted.
   *
   * @remarks A grant for discovery cannot be treated as a grant for booking
   * confirmation unless both scopes are present.
   */
  granted_scopes: ConsentScope[];

  /**
   * ISO-8601 instant at which the grant was made.
   *
   * @remarks Recording the decision time supports later audit and replay
   * analysis without storing the underlying customer message.
   */
  granted_at_iso: string;

  /**
   * Whether the grant explicitly acknowledged the liability terms.
   *
   * @remarks This boolean is a protocol acknowledgement, not proof that a
   * human read or legally accepted the terms.
   */
  liability_acknowledged: boolean;
}

/**
 * Final merchant response that records the selected offer and consent.
 */
export interface BookingConfirmation extends BookingProtocolFields {
  /**
   * Stable confirmation identifier owned by the merchant booking system.
   *
   * @remarks It is an opaque reference used for audit and later cancellation,
   * not a customer profile identifier.
   */
  confirmation_id: string;

  /**
   * Request identifier that produced this confirmation.
   *
   * @remarks The reference prevents a confirmation from being attached to an
   * unrelated handshake.
   */
  request_id: string;

  /**
   * Proposal identifier containing the selected slot.
   *
   * @remarks The reference preserves the offer-to-confirmation audit chain.
   */
  proposal_id: string;

  /**
   * Identifier of the selected slot offer.
   *
   * @remarks The selected offer must be present in the referenced proposal;
   * a free-form replacement is not accepted.
   */
  slot_offer_id: string;

  /**
   * Opaque merchant reference that owns the confirmed appointment.
   *
   * @remarks The reference avoids embedding merchant contact or account data.
   */
  merchant_identity_ref: string;

  /**
   * Consent grant used to authorize the confirmation.
   *
   * @remarks Linking the grant makes the consent check auditable without
   * retaining the underlying personal data.
   */
  consent_id: string;

  /**
   * Opaque booking-system reference returned to the customer agent.
   *
   * @remarks The reference is suitable for later lookup while keeping this
   * schema independent of a particular merchant API.
   */
  booking_reference: string;

  /**
   * ISO-8601 instant at which the merchant issued the confirmation.
   *
   * @remarks The timestamp is an audit fact, not a substitute for the slot's
   * start and end instants.
   */
  confirmed_at_iso: string;

  /**
   * Liability terms that the confirmation carries forward.
   *
   * @remarks Carrying the terms forward makes the responsibility allocation
   * visible at the point of commitment.
   */
  liability_terms: LiabilityTerms;
}

/** A booking artifact accepted by the verification boundary. */
export type BookingArtifact =
  | BookingRequest
  | BookingProposal
  | BookingConfirmation
  | SlotOffer
  | ConsentGrant;

/**
 * Check the structural shape of an opaque identity reference.
 *
 * @remarks The check rejects obvious raw-contact punctuation and long numeric
 * strings, but it is not an identity proof. Callers still need a trusted
 * identity system before using a reference for authorization.
 */
export function is_opaque_identity_ref(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value) && !/^\d{7,}$/.test(value);
}
