/** Pre-embed text hygiene: PII scrubbing and secret rejection.
 *
 * Runs between chunking and embedding (doc 08, ingestion step 5). Scrubbing
 * masks phone numbers, emails, and secret-looking assignments; anything that
 * is still unsafe after scrubbing is rejected fail-closed and never embedded.
 */

/** Placeholder replacing detected phone-number-like text. */
export const REDACTED_PHONE = "[REDACTED_PHONE]";

/** Placeholder replacing detected email addresses. */
export const REDACTED_EMAIL = "[REDACTED_EMAIL]";

/** Placeholder replacing detected secret or token material. */
export const REDACTED_SECRET = "[REDACTED_SECRET]";

/**
 * Fraction of secret placeholders above which a chunk is rejected.
 * A chunk that is mostly credentials is a leak risk, not knowledge.
 */
export const MAX_SECRET_FRACTION = 0.2;

const PHONE_PATTERN = /(\+?\d[\d\s\-().]{6,}\d)/g;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SECRET_PATTERN =
  /(api[_-]?key|secret|password|passwd|pwd|bearer|session[_-]?token)\s*[:=]\s*['"]?[^\s'"]+['"]?/gi;
const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

/** Raised when a chunk carries secret material and must be rejected. */
export class UnsafeChunkError extends Error {
  constructor(reason: string) {
    super(`unsafe chunk rejected: ${reason}`);
    this.name = "UnsafeChunkError";
  }
}

/**
 * Scrub PII from chunk text before embedding.
 *
 * Masks phone-number-like sequences and emails. Secret-looking assignments
 * are masked here too, but chunks dominated by secrets must be rejected
 * outright via assert_chunk_is_safe instead of silently cleaned.
 *
 * @param text Raw chunk text.
 * @returns Scrubbed text with PII replaced by placeholders.
 */
export function scrub_pii_from_text(text: string): string {
  return text
    .replace(SECRET_PATTERN, `${REDACTED_SECRET}`)
    .replace(EMAIL_PATTERN, REDACTED_EMAIL)
    .replace(PHONE_PATTERN, REDACTED_PHONE);
}

/**
 * Reject chunks that must never enter the index.
 *
 * A chunk is unsafe when it still contains private key material or is
 * mostly secret placeholders after scrubbing. Fail-closed: the caller must
 * drop or quarantine the chunk, never embed it.
 *
 * @param scrubbed_text Chunk text after scrub_pii_from_text.
 * @returns True when the chunk is safe to embed.
 * @throws UnsafeChunkError when secret material remains.
 */
export function assert_chunk_is_safe(scrubbed_text: string): boolean {
  if (PRIVATE_KEY_PATTERN.test(scrubbed_text)) {
    throw new UnsafeChunkError("private key material detected");
  }
  const redacted_count = scrubbed_text.split(REDACTED_SECRET).length - 1;
  const word_count = scrubbed_text.split(/\s+/).filter(Boolean).length;
  if (word_count > 0 && redacted_count / word_count > MAX_SECRET_FRACTION) {
    throw new UnsafeChunkError("chunk is mostly secret material");
  }
  return true;
}
