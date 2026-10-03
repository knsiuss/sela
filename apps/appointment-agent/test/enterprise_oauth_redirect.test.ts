/**
 * PKCE and redirect-policy coverage for the authorization-code flows.
 *
 * PKCE is asserted against a recomputation rather than against a recorded
 * literal, so a change to the derivation cannot silently pass. The redirect
 * tests cover the reflection attacks the allow-list exists to stop.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  derive_code_challenge,
  generate_pkce_pair,
  verify_pkce_challenge,
} from "../src/enterprise/oauth/pkce.js";
import {
  assert_redirect_allowed,
  build_redirect_allow_list,
  require_configured_redirect,
  require_redirect_uri,
  require_return_path,
} from "../src/enterprise/oauth/redirect_policy.js";
import {
  build_google_consent_url,
  GOOGLE_AUTHORIZATION_ENDPOINT,
} from "../src/enterprise/oauth/google_authorize.js";

const ALLOWED = ["https://staff.example.com/auth/callback"];

describe("PKCE S256", () => {
  it("generates a verifier and a matching base64url SHA-256 challenge", () => {
    const pair = generate_pkce_pair();
    expect(pair.code_verifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
    expect(pair.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pair.code_challenge_method).toBe("S256");
    const expected = createHash("sha256").update(pair.code_verifier, "ascii").digest("base64url");
    expect(pair.code_challenge).toBe(expected);
  });

  it("generates a distinct verifier per call", () => {
    const first = generate_pkce_pair();
    const second = generate_pkce_pair();
    expect(first.code_verifier).not.toBe(second.code_verifier);
  });

  it("never produces a plain-method challenge", () => {
    expect(generate_pkce_pair().code_challenge).not.toBe(generate_pkce_pair().code_verifier);
  });

  it("verifies a matching pair and rejects a substituted verifier", () => {
    const pair = generate_pkce_pair();
    expect(verify_pkce_challenge(pair.code_verifier, pair.code_challenge)).toBe(true);
    const other = generate_pkce_pair();
    expect(verify_pkce_challenge(other.code_verifier, pair.code_challenge)).toBe(false);
  });

  it("rejects a tampered challenge of a different length without throwing", () => {
    const pair = generate_pkce_pair();
    expect(verify_pkce_challenge(pair.code_verifier, "short")).toBe(false);
    expect(verify_pkce_challenge("short", pair.code_challenge)).toBe(false);
  });

  it("rejects a verifier outside the RFC 7636 length or alphabet", () => {
    expect(() => derive_code_challenge("a".repeat(42))).toThrow("pkce-verifier-invalid");
    expect(() => derive_code_challenge("a".repeat(129))).toThrow("pkce-verifier-invalid");
    expect(() => derive_code_challenge(`${"a".repeat(42)}+`)).toThrow("pkce-verifier-invalid");
  });

  it("fails closed when the entropy source returns too few bytes", () => {
    expect(() => generate_pkce_pair(() => Buffer.alloc(8))).toThrow("pkce-entropy-unavailable");
  });
});

describe("redirect_uri allow-list", () => {
  it("accepts an https redirect and an http loopback redirect", () => {
    expect(require_redirect_uri("https://staff.example.com/auth/callback")).toBe("https://staff.example.com/auth/callback");
    expect(require_redirect_uri("http://127.0.0.1:3000/auth/callback")).toBe("http://127.0.0.1:3000/auth/callback");
  });

  it("refuses http on a routable host so a redirect cannot be downgraded", () => {
    expect(() => require_redirect_uri("http://staff.example.com/auth/callback")).toThrow();
  });

  it("refuses a relative, credentialed, or fragmented redirect", () => {
    for (const value of ["/auth/callback", "https://user:pw@staff.example.com/cb", "https://staff.example.com/cb#x"]) {
      expect(() => require_redirect_uri(value)).toThrow();
    }
  });

  it("refuses a redirect that is not on the allow-list", () => {
    const allow_list = build_redirect_allow_list(ALLOWED);
    expect(assert_redirect_allowed("https://staff.example.com/auth/callback", allow_list)).toBe(
      "https://staff.example.com/auth/callback",
    );
    expect(() => assert_redirect_allowed("https://attacker.example/auth/callback", allow_list)).toThrow();
    expect(() => assert_redirect_allowed("https://staff.example.com/auth/callback/../other", allow_list)).toThrow();
  });

  it("treats a prefix of an allow-listed host as a different origin", () => {
    const allow_list = build_redirect_allow_list(["https://staff.example.com/auth/callback"]);
    expect(() => assert_redirect_allowed("https://staff.example.com.attacker.test/auth/callback", allow_list)).toThrow();
    expect(() => assert_redirect_allowed("https://staff.example.com/auth/callback2", allow_list)).toThrow();
  });

  it("refuses an empty or oversized allow-list", () => {
    expect(() => build_redirect_allow_list([])).toThrow();
    expect(() => build_redirect_allow_list(new Array(9).fill("https://a.example.com/cb"))).toThrow();
  });

  it("de-duplicates repeated allow-list entries", () => {
    expect(build_redirect_allow_list([...ALLOWED, ...ALLOWED])).toHaveLength(1);
  });

  it("resolves the callback URI from configuration rather than the request", () => {
    expect(
      require_configured_redirect({ CALLBACK: "https://staff.example.com/auth/callback" }, "CALLBACK"),
    ).toBe("https://staff.example.com/auth/callback");
    expect(() => require_configured_redirect({}, "CALLBACK")).toThrow();
  });
});

describe("return path validation", () => {
  it("accepts an allow-listed relative path", () => {
    expect(require_return_path("/actions", ["/actions"])).toBe("/actions");
  });

  it("refuses absolute, protocol-relative, traversing, and unlisted paths", () => {
    const allowed = ["/actions", "/audit"];
    for (const value of ["https://evil.example", "//evil.example", "/actions/../admin", "/admin", "", "/actions/"]) {
      expect(() => require_return_path(value, allowed)).toThrow();
    }
  });

  it("refuses a backslash path that some browsers normalize to a separator", () => {
    expect(() => require_return_path("/actions\\..\\admin", ["/actions"])).toThrow();
  });
});

describe("Google consent request construction", () => {
  const BASE = {
    client_id: "google-client-id",
    redirect_uri: "https://staff.example.com/auth/callback",
    state: "s".repeat(43),
    code_challenge: "c".repeat(43),
    nonce: "n".repeat(32),
  };

  it("requests every supplied scope, de-duplicated, without a client secret", () => {
    const url = new URL(build_google_consent_url({
      ...BASE,
      scopes: ["openid", "email", "openid"],
    }));
    expect(url.origin + url.pathname).toBe(GOOGLE_AUTHORIZATION_ENDPOINT);
    expect(url.searchParams.get("scope")).toBe("openid email");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.has("client_secret")).toBe(false);
  });

  it("refuses an oversized scope list instead of truncating mid-scope", () => {
    // Truncation would ask Google for a scope that does not exist, so the
    // consent screen would differ from what the flow believes it requested.
    const oversized = Array.from(
      { length: 16 },
      (_value, index) => `https://www.googleapis.com/auth/scope-${index}-${"x".repeat(30)}`,
    );
    expect(oversized.join(" ").length).toBeGreaterThan(1024);
    expect(() => build_google_consent_url({ ...BASE, scopes: oversized })).toThrow(/oauth_configuration_invalid/);
    expect(() => build_google_consent_url({ ...BASE, scopes: ["openid", "email"] })).not.toThrow();
  });

  it("refuses an empty or malformed scope list", () => {
    expect(() => build_google_consent_url({ ...BASE, scopes: [] })).toThrow(/oauth_configuration_invalid/);
    expect(() => build_google_consent_url({ ...BASE, scopes: ["not a scope"] })).toThrow(/oauth_configuration_invalid/);
  });
});
