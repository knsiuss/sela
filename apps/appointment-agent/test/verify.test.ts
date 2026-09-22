import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  MissingChallengeError,
  MissingVerifyTokenError,
  VerifyTokenMismatchError,
  compute_signature_hex,
  constant_time_equal,
  is_valid_signature,
  verify_challenge,
} from "../src/ingress/verify.js";

const APP_SECRET = "test-app-secret";
const RAW_BODY = JSON.stringify({ object: "whatsapp_business_account" });

function signed_header(body: string, secret: string): string {
  const hex = createHmac("sha256", secret).update(body).digest("hex");
  return `sha256=${hex}`;
}

describe("constant_time_equal", () => {
  it("test_returns_true_for_matching_tokens", () => {
    expect(constant_time_equal("token-abc", "token-abc")).toBe(true);
  });

  it("test_returns_false_for_mismatched_tokens", () => {
    expect(constant_time_equal("token-abc", "token-abd")).toBe(false);
  });

  it("test_returns_false_for_different_lengths_without_throwing", () => {
    expect(constant_time_equal("short", "a-much-longer-token")).toBe(false);
  });
});

describe("verify_challenge", () => {
  it("test_returns_challenge_when_token_matches", () => {
    const challenge = verify_challenge(
      { hub_mode: "subscribe", hub_verify_token: "secret-token", hub_challenge: "42" },
      "secret-token",
    );
    expect(challenge).toBe("42");
  });

  it("test_rejects_wrong_token_without_leaking_value", () => {
    try {
      verify_challenge(
        { hub_mode: "subscribe", hub_verify_token: "wrong", hub_challenge: "42" },
        "secret-token",
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(VerifyTokenMismatchError);
      expect(String(error)).not.toContain("secret-token");
    }
  });

  it("test_rejects_missing_token_and_challenge", () => {
    expect(() => verify_challenge({ hub_mode: "subscribe" }, "secret-token")).toThrow(
      MissingVerifyTokenError,
    );
    expect(() =>
      verify_challenge({ hub_mode: "subscribe", hub_verify_token: "secret-token" }, "secret-token"),
    ).toThrow(MissingChallengeError);
  });

  it("test_rejects_wrong_hub_mode", () => {
    expect(() =>
      verify_challenge(
        { hub_mode: "unsubscribe", hub_verify_token: "secret-token", hub_challenge: "42" },
        "secret-token",
      ),
    ).toThrow(VerifyTokenMismatchError);
  });
});

describe("is_valid_signature", () => {
  it("test_accepts_genuine_meta_signature", () => {
    expect(is_valid_signature(RAW_BODY, signed_header(RAW_BODY, APP_SECRET), APP_SECRET)).toBe(
      true,
    );
  });

  it("test_rejects_tampered_body", () => {
    const header = signed_header(RAW_BODY, APP_SECRET);
    expect(is_valid_signature(`${RAW_BODY} `, header, APP_SECRET)).toBe(false);
  });

  it("test_rejects_wrong_secret", () => {
    const header = signed_header(RAW_BODY, "other-secret");
    expect(is_valid_signature(RAW_BODY, header, APP_SECRET)).toBe(false);
  });

  it("test_rejects_missing_and_malformed_headers", () => {
    expect(is_valid_signature(RAW_BODY, undefined, APP_SECRET)).toBe(false);
    expect(is_valid_signature(RAW_BODY, "not-a-signature", APP_SECRET)).toBe(false);
    expect(is_valid_signature(RAW_BODY, "sha256=zzzz", APP_SECRET)).toBe(false);
  });

  it("test_compute_signature_hex_matches_known_vector", () => {
    const expected = createHmac("sha256", APP_SECRET).update(RAW_BODY).digest("hex");
    expect(compute_signature_hex(RAW_BODY, APP_SECRET)).toBe(expected);
  });
});
