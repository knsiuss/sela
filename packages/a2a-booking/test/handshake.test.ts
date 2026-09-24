import { describe, expect, it } from "vitest";
import {
  apply_handshake_event,
  IllegalHandshakeTransitionError,
  InMemoryMerchantAgentTransport,
  MerchantTransportError,
  initiate_handshake,
  transition_handshake,
  verify_booking,
  type ConfirmBookingInput,
} from "../src/index.js";
import {
  make_consent,
  make_liability_terms,
  make_proposal,
  make_request,
  make_slot_offer,
  TEST_NOW_ISO,
  TEST_NOW_MS,
  TEST_POLICY_VERSION,
} from "./fixtures.js";

function make_transport(): InMemoryMerchantAgentTransport {
  return new InMemoryMerchantAgentTransport({
    merchant_identity_ref: "merchant_agent_001",
    slot_offers: [make_slot_offer()],
    liability_terms: make_liability_terms(),
    clock: () => TEST_NOW_ISO,
  });
}

describe("merchant handshake", () => {
  it("test_completes_full_happy_handshake_without_network", async () => {
    const request = make_request();
    const transport = make_transport();
    const proposal = await transport.propose_slots(request);
    const consent = make_consent();

    let session = initiate_handshake(request);
    session = apply_handshake_event(session, { type: "offer_slots", proposal });
    session = apply_handshake_event(session, {
      type: "request_consent",
      required_scopes: proposal.required_consent_scopes,
    });
    session = apply_handshake_event(session, { type: "grant_consent", consent });

    const proposal_verification = verify_booking(proposal, {
      expected_policy_version: TEST_POLICY_VERSION,
      seen_idempotency_keys: new Set(),
      now_epoch_ms: TEST_NOW_MS,
      consent_grant: consent,
    });
    expect(proposal_verification.is_verified).toBe(true);

    const confirmation = await transport.confirm_booking({
      proposal,
      consent,
      selected_slot_offer_id: proposal.slot_offers[0].slot_offer_id,
      idempotency_key: "confirm_op_001",
    });
    const confirmation_verification = verify_booking(confirmation, {
      expected_policy_version: TEST_POLICY_VERSION,
      seen_idempotency_keys: new Set(),
      now_epoch_ms: TEST_NOW_MS,
      consent_grant: consent,
    });
    expect(confirmation_verification.is_verified).toBe(true);

    session = apply_handshake_event(session, { type: "confirm_booking", confirmation });
    expect(session.state).toBe("confirmed");
    expect(session.proposal).toBe(proposal);
    expect(session.consent).toBe(consent);
    expect(session.confirmation).toBe(confirmation);
  });

  it("test_illegal_transition_throws_domain_error", () => {
    expect(transition_handshake("initiated", "counterparty_offered")).toBe("counterparty_offered");
    expect(() => transition_handshake("initiated", "confirm_booking")).toThrow(
      IllegalHandshakeTransitionError,
    );
    expect(() => transition_handshake("confirmed", "reject")).toThrow(
      IllegalHandshakeTransitionError,
    );
  });

  it("test_duplicate_confirmation_returns_same_result", async () => {
    const request = make_request();
    const transport = make_transport();
    const proposal = await transport.propose_slots(request);
    const consent = make_consent();
    const input: ConfirmBookingInput = {
      proposal,
      consent,
      selected_slot_offer_id: proposal.slot_offers[0].slot_offer_id,
      idempotency_key: "confirm_op_retry_001",
    };

    const first = await transport.confirm_booking(input);
    const second = await transport.confirm_booking(input);

    expect(second).toBe(first);
  });

  it("test_expired_proposal_is_rejected_by_verification", () => {
    const proposal = {
      ...make_proposal(),
      expires_at_iso: "2026-09-24T09:00:00.000Z",
    };
    const result = verify_booking(proposal, {
      expected_policy_version: TEST_POLICY_VERSION,
      seen_idempotency_keys: new Set(),
      now_epoch_ms: TEST_NOW_MS,
      consent_grant: make_consent(),
    });

    expect(result.is_verified).toBe(false);
    expect(result.reason).toBe("expired");
  });

  it("test_rejects_conflicting_idempotency_key_on_confirmation", async () => {
    const request = make_request();
    const transport = make_transport();
    const proposal = await transport.propose_slots(request);
    const consent = make_consent();
    const input: ConfirmBookingInput = {
      proposal,
      consent,
      selected_slot_offer_id: proposal.slot_offers[0].slot_offer_id,
      idempotency_key: "confirm_op_conflict_001",
    };

    await transport.confirm_booking(input);
    await expect(
      transport.confirm_booking({ ...input, selected_slot_offer_id: "different_slot" }),
    ).rejects.toThrow(MerchantTransportError);
  });

  it("test_rejects_expired_request_in_transport", async () => {
    const transport = new InMemoryMerchantAgentTransport({
      merchant_identity_ref: "merchant_agent_001",
      slot_offers: [make_slot_offer()],
      liability_terms: make_liability_terms(),
      clock: () => "2026-09-24T12:00:00.000Z",
    });

    await expect(transport.propose_slots(make_request())).rejects.toThrow(MerchantTransportError);
  });
});
