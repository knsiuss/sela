/** Concierge-only cross-tenant search node for the appointment agent. */

import {
  AvailabilityProviderError,
  SlotBroker,
  type Offer,
  type SearchIntent,
} from "@repo/slot-broker";

/** Authorization decision supplied by the authenticated conversation boundary. */
export interface CrossTenantSearchAuthorizer {
  can_search(requester_tenant_id: string): boolean;
}

/** Request passed from an authenticated conversation boundary. */
export interface CrossTenantSearchRequest {
  intent: SearchIntent;
  /** Kept for routing only; raw customer text is not returned or logged. */
  user_message: string;
}

/** Safe user-visible result from the cross-tenant search node. */
export interface CrossTenantSearchResponse {
  status: "not_authorized" | "consent_required" | "provider_unavailable" | "offers" | "no_offers";
  user_message: string;
  offers: Offer[];
  requires_human_approval: true;
}

const CROSS_TENANT_SEARCH_PATTERN = /\b(cari|find|search)\s+(slot|jadwal)\b/iu;
const CONSENT_REQUEST_MESSAGE =
  "Before I search partner businesses, may I opt in to share only the minimum availability needed for this request? " +
  "No partner calendar will be queried without your opt-in.";
const NO_BOOKING_MESSAGE = "No booking was made.";
const NOT_AUTHORIZED_MESSAGE = "This search is not available for this conversation.";
const PROVIDER_UNAVAILABLE_MESSAGE =
  "Partner availability is temporarily unavailable. No booking was made.";

type RefusalStatus = Exclude<CrossTenantSearchResponse["status"], "offers">;

function build_refusal(status: RefusalStatus, user_message: string): CrossTenantSearchResponse {
  return {
    status,
    user_message,
    offers: [],
    requires_human_approval: true,
  };
}

function is_authorized(
  request: CrossTenantSearchRequest,
  authorizer: CrossTenantSearchAuthorizer,
): boolean {
  const requester_tenant_id = request?.intent?.requester_tenant_id;
  if (
    typeof requester_tenant_id !== "string" ||
    requester_tenant_id.trim() === "" ||
    typeof authorizer?.can_search !== "function"
  ) {
    return false;
  }
  try {
    return authorizer.can_search(requester_tenant_id) === true;
  } catch {
    // An authorization dependency failure must never become an implicit allow.
    return false;
  }
}

async function get_offers(
  request: CrossTenantSearchRequest,
  broker: SlotBroker,
): Promise<Offer[] | undefined> {
  try {
    return await broker.search(request.intent);
  } catch (error) {
    if (error instanceof AvailabilityProviderError) {
      return undefined;
    }
    throw error;
  }
}

function build_no_offers_response(offers: Offer[]): CrossTenantSearchResponse {
  return {
    status: "no_offers",
    user_message: `No eligible partner slots were found. ${NO_BOOKING_MESSAGE}`,
    offers,
    requires_human_approval: true,
  };
}

function build_offers_response(offers: Offer[]): CrossTenantSearchResponse {
  return {
    status: "offers",
    user_message: `${offers[0]?.summary} ${NO_BOOKING_MESSAGE} A staff member must review any selection.`,
    offers,
    requires_human_approval: true,
  };
}

/**
 * Detect the bounded cross-tenant intent without an LLM.
 *
 * Args:
 *   message: Raw customer message from the existing routing layer.
 *
 * Returns:
 *   True when the message explicitly asks to search for slots.
 */
export function is_cross_tenant_search_message(message: string): boolean {
  if (typeof message !== "string") return false;
  return CROSS_TENANT_SEARCH_PATTERN.test(message.trim());
}

/**
 * Search partner tenants only after explicit requester opt-in.
 *
 * This node is deliberately a partial concierge integration. It returns
 * consent-card offers and never invokes the normal calendar hold/write flow.
 * Human approval is a required next state, even after a customer chooses a
 * card, and that approval is outside this package.
 *
 * Args:
 *   request: Search intent and the raw message used by upstream routing.
 *   broker: Read-only broker with an injected availability provider.
 *   authorizer: Authenticated-boundary decision; anything other than true
 *     fails closed before provider work.
 *
 * Returns:
 *   An authorization refusal, a clarification when consent is absent, a safe
 *   provider-unavailable response, or offers/a no-results message. Partner
 *   providers are not called on either refusal path.
 */
export async function cross_tenant_search_node(
  request: CrossTenantSearchRequest,
  broker: SlotBroker,
  authorizer: CrossTenantSearchAuthorizer,
): Promise<CrossTenantSearchResponse> {
  if (request?.intent?.consent_granted !== true) {
    return build_refusal("consent_required", CONSENT_REQUEST_MESSAGE);
  }

  if (!is_authorized(request, authorizer)) {
    return build_refusal("not_authorized", NOT_AUTHORIZED_MESSAGE);
  }

  const offers = await get_offers(request, broker);
  if (offers === undefined) {
    return build_refusal("provider_unavailable", PROVIDER_UNAVAILABLE_MESSAGE);
  }
  return offers.length === 0 ? build_no_offers_response(offers) : build_offers_response(offers);
}
