import { describe, expect, it } from "vitest";
import {
  AgentCardValidationError,
  build_merchant_agent_card,
  type MerchantAgentCard,
  type MerchantAgentCardInput,
  validate_merchant_agent_card,
} from "../src/index.js";

function make_card(): MerchantAgentCard {
  return {
    agent_id: "merchant_agent_sela_001",
    display_name: "Sela Dental Merchant",
    supported_verticals: ["dental"],
    supported_actions: ["propose_slots", "confirm_booking", "cancel_booking"],
    consent_requirements: [
      {
        scope: "discover_slots",
        purpose: "Discover available appointment times.",
        required: true,
      },
    ],
    endpoint: "https://merchant.example/a2a",
    policy_version: "2026-09-roadmap-v1",
    signature: "placeholder:merchant-card-v1",
  };
}

describe("merchant agent card", () => {
  it("test_builds_a_valid_roadmap_card", () => {
    const card = build_merchant_agent_card(make_card());

    expect(card.agent_id).toBe("merchant_agent_sela_001");
    expect(validate_merchant_agent_card(card).is_valid).toBe(true);
  });

  it("test_rejects_untrusted_card_when_signature_field_is_missing", () => {
    const untrusted: Record<string, unknown> = { ...make_card() };
    delete untrusted.signature;

    const result = validate_merchant_agent_card(untrusted);
    expect(result.is_valid).toBe(false);
    expect(result.reason).toBe("missing_signature");
    expect(() => build_merchant_agent_card(untrusted as unknown as MerchantAgentCardInput)).toThrow(
      AgentCardValidationError,
    );
  });

  it("test_rejects_non_https_endpoint", () => {
    const result = validate_merchant_agent_card({ ...make_card(), endpoint: "http://merchant.example/a2a" });

    expect(result.is_valid).toBe(false);
    expect(result.reason).toBe("invalid_endpoint");
  });
});
