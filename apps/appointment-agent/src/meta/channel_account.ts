/**
 * Read the Meta channel account id from a single webhook change value.
 *
 * Meta's documented `messages` and `statuses` webhooks carry the channel
 * account in `value.metadata.phone_number_id` only; there is no top-level
 * `value.phone_number_id` in either direction. Both ingress call sites read the
 * channel account through this module so they cannot drift apart again.
 *
 * Why there is deliberately no top-level fallback: ingress consumes the raw
 * body synchronously inside the request and never re-reads a persisted raw
 * body (the dedupe store keeps only `(tenant_id, wamid)` claims and status
 * events are applied inline), so no already-buffered legacy payload can need a
 * fallback. On an access-control boundary a second, attacker-steerable source of
 * truth for tenant routing is worse than failing closed, so an unusable account
 * id resolves to `""` and the delivery is counted unresolved.
 */

/** Upper bound matching the tenant resolver's own account-id limit. */
const MAX_ACCOUNT_ID_LENGTH = 256;

/** Control characters are never part of a provider account id. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

/**
 * Extract the channel account id from one `changes[].value` object.
 *
 * Fails closed to an empty string for a missing or non-object `metadata`, a
 * missing, non-string, blank, over-long, or control-character value, so an
 * unusable payload can never be routed as a known channel. The value itself is
 * never included in an error, log line, or metric label.
 *
 * @param value - Untrusted `changes[].value` object from a signed webhook.
 * @returns The documented `value.metadata.phone_number_id`, or `""` when unusable.
 */
export function extract_channel_account_id(value: unknown): string {
  if (typeof value !== "object" || value === null) return "";
  const metadata = (value as Record<string, unknown>)["metadata"];
  if (typeof metadata !== "object" || metadata === null) return "";
  return normalize_account_id((metadata as Record<string, unknown>)["phone_number_id"]);
}

/**
 * Normalize an untrusted account id without echoing its value.
 *
 * @param candidate - Untrusted provider field value.
 * @returns The trimmed id, or `""` when it cannot identify a channel.
 */
function normalize_account_id(candidate: unknown): string {
  if (typeof candidate !== "string") return "";
  const account_id = candidate.trim();
  if (account_id.length < 1 || account_id.length > MAX_ACCOUNT_ID_LENGTH) return "";
  if (CONTROL_CHARACTERS.test(account_id)) return "";
  return account_id;
}