/**
 * PII scrubbing for text that is about to leave the process.
 *
 * Today nothing in `apps/appointment-agent` sends raw customer text anywhere,
 * and several tests assert that. Adding a model boundary changes that, so the
 * guarantee is made explicit and testable here rather than left as a comment:
 * every model-bound string passes through {@link redact_pii} first.
 *
 * The detection itself is reused from `@repo/rag-pipeline` instead of being
 * reimplemented, so one PII rule set governs RAG ingestion and model calls.
 */

import {
  REDACTED_EMAIL,
  REDACTED_PHONE,
  REDACTED_SECRET,
  scrub_pii_from_text,
} from "@repo/rag-pipeline";

/** Longest text accepted at a model boundary; longer input is truncated. */
export const MAX_REDACTED_TEXT_CHARS = 4_000;

export { REDACTED_EMAIL, REDACTED_PHONE, REDACTED_SECRET };

/**
 * Remove phone numbers, emails, and secret-looking assignments from text.
 *
 * Truncation happens after scrubbing so a cut-off boundary cannot leave a
 * partially masked phone number behind.
 *
 * @param text - Untrusted text that may contain PII.
 * @returns Scrubbed text bounded to {@link MAX_REDACTED_TEXT_CHARS}.
 */
export function redact_pii(text: string): string {
  return scrub_pii_from_text(text).slice(0, MAX_REDACTED_TEXT_CHARS);
}

/**
 * True when a scrubbed string still carries a detectable identifier.
 *
 * Used by tests and by the classifier to assert that no recipient PII reached
 * the provider payload. A match means redaction was bypassed, not that the
 * input was merely unusual.
 *
 * @param scrubbed_text - Text already passed through {@link redact_pii}.
 * @returns True when an unredacted phone or email pattern survives.
 */
export function contains_residual_pii(scrubbed_text: string): boolean {
  const residual_phone = /\+?\d[\d\s\-().]{6,}\d/;
  const residual_email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  return residual_phone.test(scrubbed_text) || residual_email.test(scrubbed_text);
}