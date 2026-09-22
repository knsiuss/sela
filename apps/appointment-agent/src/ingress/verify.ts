import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_PREFIX = "sha256=";
export const SIGNATURE_HEX_LENGTH = 64;

export class MissingVerifyTokenError extends Error {
  constructor() {
    super("verify-token-missing");
    this.name = "MissingVerifyTokenError";
  }
}

export class VerifyTokenMismatchError extends Error {
  constructor() {
    // Never include either token value; both are secrets.
    super("verify-token-mismatch");
    this.name = "VerifyTokenMismatchError";
  }
}

export class MissingChallengeError extends Error {
  constructor() {
    super("verify-challenge-missing");
    this.name = "MissingChallengeError";
  }
}

export interface VerifyQuery {
  hub_mode?: string;
  hub_verify_token?: string;
  hub_challenge?: string;
}

/**
 * Compare two secret strings in constant time.
 *
 * Both inputs are SHA-256 hashed first so unequal lengths do not
 * throw and do not leak length via timing. Returns false on
 * non-string input instead of throwing, so callers fail closed.
 *
 * Args:
 *   provided: Value received from the request.
 *   expected: Value stored server-side.
 *
 * Returns:
 *   True when the values are equal, false otherwise.
 */
export function constant_time_equal(provided: string, expected: string): boolean {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  const provided_hash = createHash("sha256").update(provided, "utf8").digest();
  const expected_hash = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(provided_hash, expected_hash);
}

/**
 * Validate a Meta webhook verification (GET) request.
 *
 * Args:
 *   query: Parsed hub.mode / hub.verify_token / hub.challenge fields.
 *   expected_token: Server-side verify token from the secret manager.
 *
 * Returns:
 *   The hub.challenge string to echo back with HTTP 200.
 *
 * Raises:
 *   MissingVerifyTokenError: If the token field is absent or empty.
 *   MissingChallengeError: If the challenge field is absent or empty.
 *   VerifyTokenMismatchError: If mode is not subscribe or token mismatches.
 */
export function verify_challenge(query: VerifyQuery, expected_token: string): string {
  const provided_token = query.hub_verify_token ?? "";
  const challenge = query.hub_challenge ?? "";
  if (provided_token === "") throw new MissingVerifyTokenError();
  if (challenge === "") throw new MissingChallengeError();
  if (query.hub_mode !== "subscribe") throw new VerifyTokenMismatchError();
  if (!constant_time_equal(provided_token, expected_token)) {
    throw new VerifyTokenMismatchError();
  }
  return challenge;
}

/**
 * Compute the expected hex HMAC-SHA256 digest of a webhook body.
 *
 * Args:
 *   raw_body: Exact raw request bytes as received, before any parsing.
 *   app_secret: Meta app secret from the secret manager.
 *
 * Returns:
 *   Lowercase hex digest string (64 chars).
 */
export function compute_signature_hex(raw_body: Buffer | string, app_secret: string): string {
  return createHmac("sha256", app_secret).update(raw_body).digest("hex");
}

/**
 * Validate an inbound webhook (POST) against X-Hub-Signature-256.
 *
 * Fails closed: missing, malformed, or mismatched signatures all
 * return false. Never throws on attacker-controlled input.
 *
 * Args:
 *   raw_body: Exact raw request bytes as received, before any parsing.
 *   signature_header: Value of the X-Hub-Signature-256 header.
 *   app_secret: Meta app secret from the secret manager.
 *
 * Returns:
 *   True only when the signature is present, well-formed, and matches.
 */
export function is_valid_signature(
  raw_body: Buffer | string,
  signature_header: string | undefined,
  app_secret: string,
): boolean {
  if (!signature_header || !signature_header.startsWith(SIGNATURE_PREFIX)) return false;
  const hex_digest = signature_header.slice(SIGNATURE_PREFIX.length);
  if (hex_digest.length !== SIGNATURE_HEX_LENGTH) return false;
  if (!/^[0-9a-fA-F]{64}$/.test(hex_digest)) return false;
  const expected_hex = compute_signature_hex(raw_body, app_secret);
  const received_bytes = Buffer.from(hex_digest.toLowerCase(), "utf8");
  const expected_bytes = Buffer.from(expected_hex, "utf8");
  return timingSafeEqual(received_bytes, expected_bytes);
}
