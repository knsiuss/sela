import { describe, expect, it } from "vitest";
import { verify_booking } from "../src/index.js";
import {
  make_consent,
  make_proposal,
  make_slot_offer,
  TEST_NOW_MS,
  TEST_POLICY_VERSION,
} from "./fixtures.js";

const proposal = make_proposal();
const consent = make_consent();

function make_context(overrides: Partial<Parameters<typeof verify_booking>[1]> = {}) {
  return {
    expected_policy_version: TEST_POLICY_VERSION,
    seen_idempotency_keys: new Set<string>(),
    now_epoch_ms: TEST_NOW_MS,
    consent_grant: consent,
    ...overrides,
  };
}

describe("incoming booking verification", () => {
  it("test_rejects_missing_consent", () => {
    const result = verify_booking(proposal, make_context({ consent_grant: undefined }));

    expect(result.is_verified).toBe(false);
    expect(result.reason).toBe("missing_consent");
  });

  it("test_rejects_policy_version_mismatch", () => {
    const result = verify_booking(proposal, make_context({ expected_policy_version: "other-policy" }));

    expect(result.is_verified).toBe(false);
    expect(result.reason).toBe("policy_version_mismatch");
  });

  it("test_rejects_duplicate_idempotency_key", () => {
    const result = verify_booking(
      proposal,
      make_context({ seen_idempotency_keys: new Set([proposal.idempotency_key]) }),
    );

    expect(result.is_verified).toBe(false);
    expect(result.reason).toBe("idempotency_duplicate");
  });

  it("test_rejects_consent_without_required_scope", () => {
    const result = verify_booking(
      proposal,
      make_context({ consent_grant: make_consent({ granted_scopes: ["discover_slots"] }) }),
    );

    expect(result.is_verified).toBe(false);
    expect(result.reason).toBe("consent_scope_missing");
  });

  it("test_rejects_expired_slot_offer_inside_proposal", () => {
    const expired_slot_proposal = make_proposal({
      slot_offers: [make_slot_offer({ expires_at_iso: "2026-09-24T09:00:00.000Z" })],
    });
    const result = verify_booking(expired_slot_proposal, make_context());

    expect(result.is_verified).toBe(false);
    expect(result.reason).toBe("expired");
  });

  it("test_rejects_when_idempotency_store_is_unavailable", () => {
    const result = verify_booking(proposal, {
      expected_policy_version: TEST_POLICY_VERSION,
      now_epoch_ms: TEST_NOW_MS,
      consent_grant: consent,
    } as unknown as Parameters<typeof verify_booking>[1]);

    expect(result.is_verified).toBe(false);
    expect(result.reason).toBe("idempotency_store_unavailable");
  });
});
