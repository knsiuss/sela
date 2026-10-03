/**
 * RFC 7636 PKCE (S256) material for every authorization-code request.
 *
 * Both staff login and the Google Calendar consent flow use the same generator,
 * so a code can only be exchanged by the process that started the flow. The
 * verifier is treated as a short-lived secret: it is stored hashed inside the
 * state record, and it is never logged, returned to a browser, or included in an
 * error message.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Only the S256 challenge method is accepted; `plain` is refused. */
export const PKCE_CHALLENGE_METHOD = "S256" as const;

/** RFC 7636 verifier length bounds. */
const MIN_VERIFIER_CHARS = 43;
const MAX_VERIFIER_CHARS = 128;
const VERIFIER_PATTERN = /^[A-Za-z0-9._~-]+$/;
const VERIFIER_ENTROPY_BYTES = 32;

/** One PKCE pair; the challenge travels to the IdP, the verifier stays local. */
export interface PkcePair {
  code_verifier: string;
  code_challenge: string;
  code_challenge_method: typeof PKCE_CHALLENGE_METHOD;
}

/**
 * Generate a fresh PKCE verifier and its S256 challenge.
 *
 * A 32-byte random base64url verifier yields exactly the RFC 7636 minimum
 * length of 43 characters, and its unreserved alphabet needs no escaping.
 *
 * @param random - Injectable entropy source for deterministic tests.
 * @returns A verifier/challenge pair; never reuse a verifier across flows.
 * @throws TypeError when no usable entropy source is available.
 */
export function generate_pkce_pair(random: () => Buffer = () => randomBytes(VERIFIER_ENTROPY_BYTES)): PkcePair {
  if (typeof random !== "function") throw new TypeError("pkce-entropy-unavailable");
  const entropy = random();
  if (!(entropy instanceof Buffer) || entropy.byteLength < VERIFIER_ENTROPY_BYTES) {
    throw new TypeError("pkce-entropy-unavailable");
  }
  const code_verifier = entropy.toString("base64url");
  return {
    code_verifier,
    code_challenge: derive_code_challenge(code_verifier),
    code_challenge_method: PKCE_CHALLENGE_METHOD,
  };
}

/**
 * Derive the S256 challenge for an existing verifier.
 *
 * @param code_verifier - RFC 7636 verifier of 43-128 unreserved characters.
 * @returns Unpadded base64url SHA-256 digest.
 * @throws TypeError when the verifier shape is invalid.
 */
export function derive_code_challenge(code_verifier: string): string {
  return createHash("sha256").update(require_verifier(code_verifier), "ascii").digest("base64url");
}

/**
 * Check a verifier against an expected S256 challenge in constant time.
 *
 * @param code_verifier - Candidate verifier recovered from the state record.
 * @param expected_challenge - Challenge that was sent to the IdP.
 * @returns True only when the verifier derives the expected challenge.
 */
export function verify_pkce_challenge(code_verifier: string, expected_challenge: string): boolean {
  if (typeof code_verifier !== "string" || typeof expected_challenge !== "string") return false;
  if (!VERIFIER_PATTERN.test(code_verifier) || code_verifier.length < MIN_VERIFIER_CHARS) return false;
  if (expected_challenge.length > MAX_VERIFIER_CHARS || code_verifier.length > MAX_VERIFIER_CHARS) return false;
  const derived = Buffer.from(derive_code_challenge(code_verifier), "utf8");
  const expected = Buffer.from(expected_challenge, "utf8");
  // Length is a public constant (43 chars) for a valid S256 challenge, so a
  // length mismatch is not secret; only the digest comparison needs to be
  // constant time.
  if (derived.byteLength !== expected.byteLength) return false;
  return timingSafeEqual(derived, expected);
}

/**
 * Validate a verifier without deriving a challenge.
 *
 * @param code_verifier - Untrusted verifier input.
 * @returns The validated verifier.
 * @throws TypeError when the length or alphabet is invalid.
 */
export function require_verifier(code_verifier: string): string {
  if (
    typeof code_verifier !== "string" ||
    code_verifier.length < MIN_VERIFIER_CHARS ||
    code_verifier.length > MAX_VERIFIER_CHARS ||
    !VERIFIER_PATTERN.test(code_verifier)
  ) {
    throw new TypeError("pkce-verifier-invalid");
  }
  return code_verifier;
}