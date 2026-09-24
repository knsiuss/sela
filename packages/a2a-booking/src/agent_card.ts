import {
  is_opaque_identity_ref,
  SUPPORTED_ACTIONS,
  type ConsentRequirement,
  type ConsentScope,
  type SupportedAction,
} from "./booking_schema.js";

/**
 * Merchant identity and capability card used during A2A discovery.
 *
 * The card is a roadmap-level contract. It advertises booking capabilities but
 * does not establish authenticity; the signature field is only a placeholder.
 */
export interface MerchantAgentCard {
  /**
   * Stable opaque identifier for the merchant agent.
   *
   * @remarks This is an identity reference, not a merchant account or contact
   * record. The validator only checks shape and never authenticates it.
   */
  agent_id: string;

  /**
   * Human-readable merchant display name.
   *
   * @remarks The name is descriptive metadata and must not be used as an
   * authorization decision.
   */
  display_name: string;

  /**
   * Appointment verticals this merchant advertises support for.
   *
   * @remarks The list is discovery metadata; a vertical still needs to be
   * checked against a proposal and merchant policy.
   */
  supported_verticals: string[];

  /**
   * Booking actions the merchant claims to support.
   *
   * @remarks All three roadmap actions are required so a card cannot silently
   * advertise a one-sided booking capability.
   */
  supported_actions: SupportedAction[];

  /**
   * Consent requirements that a customer agent must evaluate before acting.
   *
   * @remarks At least one required scope is enforced by the fail-closed
   * validator.
   */
  consent_requirements: ConsentRequirement[];

  /**
   * HTTPS endpoint advertised for a future transport adapter.
   *
   * @remarks This package never calls the endpoint; a production adapter must
   * add authentication, timeout, and policy controls. Query strings and
   * embedded credentials are rejected to avoid leaking secrets in URLs.
   */
  endpoint: string;

  /**
   * Policy identifier expected by the merchant for booking messages.
   *
   * @remarks The version is compared exactly during verification to prevent a
   * proposal from being interpreted under different consent rules.
   */
  policy_version: string;

  /**
   * Placeholder for a future detached or transport signature.
   *
   * @remarks This package requires the field to be present but does not create,
   * verify, or validate a cryptographic signature. It is deliberately not an
   * authenticity mechanism.
   */
  signature: string;
}

/**
 * Input accepted by the merchant card builder.
 */
export type MerchantAgentCardInput = MerchantAgentCard;

/**
 * Result of validating an untrusted merchant card.
 */
export interface MerchantAgentCardValidationResult {
  /**
   * Whether every required structural check passed.
   *
   * @remarks A false result must be treated as untrusted and must not be used
   * to authorize a booking.
   */
  is_valid: boolean;

  /**
   * Typed card when validation succeeds.
   *
   * @remarks The property is absent on rejection to prevent accidental use of
   * an unvalidated object.
   */
  card?: MerchantAgentCard;

  /**
   * Stable rejection reason safe for logs and protocol diagnostics.
   *
   * @remarks The reason does not include the submitted card or endpoint query
   * string, which could contain sensitive data.
   */
  reason?: string;
}

/**
 * Domain error raised when a card cannot be built safely.
 */
export class AgentCardValidationError extends Error {
  /**
   * Stable machine-readable error code.
   */
  readonly code = "invalid_merchant_agent_card";

  /**
   * Create a card validation error.
   *
   * @param reason - Safe structural reason for the rejection.
   */
  constructor(reason: string) {
    super(`Invalid merchant agent card: ${reason}`);
    this.name = "AgentCardValidationError";
  }
}

const MAX_TEXT_LENGTH = 512;
const MAX_ENDPOINT_LENGTH = 2048;

/**
 * Build a typed merchant card after fail-closed validation.
 *
 * @param input - Untrusted card-shaped input from discovery or configuration.
 * @returns A validated card with the same declared fields.
 * @throws AgentCardValidationError when any required field is missing or invalid.
 */
export function build_merchant_agent_card(input: MerchantAgentCardInput): MerchantAgentCard {
  const result = validate_merchant_agent_card(input);
  if (!result.is_valid || result.card === undefined) {
    throw new AgentCardValidationError(result.reason ?? "invalid_card");
  }
  return result.card;
}

/**
 * Validate an untrusted merchant card without making a network call.
 *
 * @param value - Unknown JSON value received from an agent or configuration.
 * @returns A fail-closed result containing a typed card only on success.
 */
export function validate_merchant_agent_card(value: unknown): MerchantAgentCardValidationResult {
  if (!is_record(value)) {
    return rejected("not_an_object");
  }
  if (!is_text(value.display_name)) {
    return rejected("missing_or_invalid_display_name");
  }
  if (!is_identity_ref(value.agent_id)) {
    return rejected("missing_or_invalid_agent_id");
  }
  if (!is_text(value.policy_version)) {
    return rejected("missing_or_invalid_policy_version");
  }
  if (!is_valid_endpoint(value.endpoint)) {
    return rejected("invalid_endpoint");
  }
  if (!is_valid_verticals(value.supported_verticals)) {
    return rejected("invalid_supported_verticals");
  }
  if (!is_valid_actions(value.supported_actions)) {
    return rejected("invalid_supported_actions");
  }
  if (!is_valid_consent_requirements(value.consent_requirements)) {
    return rejected("invalid_consent_requirements");
  }
  if (!is_text(value.signature)) {
    return rejected("missing_signature");
  }
  return { is_valid: true, card: value as unknown as MerchantAgentCard };
}

function rejected(reason: string): MerchantAgentCardValidationResult {
  return { is_valid: false, reason };
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function is_text(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= MAX_TEXT_LENGTH
  );
}

function is_identity_ref(value: unknown): value is string {
  return typeof value === "string" && is_opaque_identity_ref(value);
}

function is_endpoint_text(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= MAX_ENDPOINT_LENGTH
  );
}

function is_valid_endpoint(value: unknown): value is string {
  if (!is_endpoint_text(value) || value.includes("#")) {
    return false;
  }
  try {
    const endpoint = new URL(value);
    return (
      endpoint.protocol === "https:" &&
      endpoint.username === "" &&
      endpoint.password === "" &&
      endpoint.search === ""
    );
  } catch {
    return false;
  }
}

function is_valid_verticals(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) {
    return false;
  }
  const seen = new Set<string>();
  for (const vertical of value) {
    if (!is_text(vertical) || seen.has(vertical)) {
      return false;
    }
    seen.add(vertical);
  }
  return true;
}

function is_valid_actions(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== SUPPORTED_ACTIONS.length) {
    return false;
  }
  const actions = new Set<SupportedAction>();
  for (const action of value) {
    if (!is_supported_action(action) || actions.has(action)) {
      return false;
    }
    actions.add(action);
  }
  return SUPPORTED_ACTIONS.every((action) => actions.has(action));
}

function is_supported_action(value: unknown): value is SupportedAction {
  return SUPPORTED_ACTIONS.includes(value as SupportedAction);
}

function is_valid_consent_requirements(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) {
    return false;
  }
  const scopes = new Set<ConsentScope>();
  let has_required_scope = false;
  for (const requirement of value) {
    if (!is_record(requirement) || !is_consent_scope(requirement.scope)) {
      return false;
    }
    if (scopes.has(requirement.scope) || !is_text(requirement.purpose)) {
      return false;
    }
    if (typeof requirement.required !== "boolean") {
      return false;
    }
    has_required_scope ||= requirement.required;
    scopes.add(requirement.scope);
  }
  return has_required_scope;
}

function is_consent_scope(value: unknown): value is ConsentScope {
  return ["discover_slots", "confirm_booking", "cancel_booking"].includes(value as ConsentScope);
}
