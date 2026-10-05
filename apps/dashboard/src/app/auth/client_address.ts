/**
 * Derive an admission bucket key from an incoming request.
 *
 * The staff-auth entry points are unauthenticated, so admission control is the
 * only thing standing between one source and the state store. That control has to
 * name a source, and naming one has a trap in it: `X-Forwarded-For` is a request
 * header, so trusting it unconditionally lets a caller mint a fresh bucket per
 * request and disables the limiter entirely.
 *
 * The deployment therefore states how many reverse proxies it fronts, and this
 * module only believes the header when that count is positive. With zero — the
 * default, and the only shape a directly-exposed instance can honestly claim —
 * every caller shares one bucket, which is conservative rather than wrong: a
 * shared bucket throttles more than strictly necessary, never less.
 *
 * The returned key is a truncated SHA-256 digest rather than the address. The
 * admission limiter keeps one key per source in a long-lived map, and a raw
 * address in that map would be retained client PII for no benefit; the digest
 * distinguishes sources just as well and cannot be reversed.
 *
 * Nothing here logs. A client address is PII, and the failure modes this module
 * handles are all "behave as if everyone is the same caller", not "record who it
 * was".
 */

import { createHash } from "node:crypto";
import { isIP } from "node:net";

/** Bucket shared by every caller when no proxy is trusted. */
const DIRECT_BUCKET = "direct";

/** Longest forwarded-address entry this module will read. */
const MAX_ADDRESS_CHARS = 64;

/** Hex characters kept from the digest; a collision here costs one shared bucket. */
const KEY_HEX_CHARS = 32;

/**
 * Resolve the admission bucket for one request.
 *
 * @param request - Incoming request; only headers are read.
 * @param trusted_proxy_hops - Number of proxies that append to
 * `X-Forwarded-For`; zero disables header trust entirely.
 * @returns A stable opaque bucket key.
 */
export function source_bucket_key(request: Request, trusted_proxy_hops: number): string {
  const hops = Number.isSafeInteger(trusted_proxy_hops) ? trusted_proxy_hops : 0;
  if (hops <= 0) return DIRECT_BUCKET;
  const address = forwarded_address(request.headers.get("x-forwarded-for"), hops);
  return address === null ? DIRECT_BUCKET : `hop:${digest(address)}`;
}

/**
 * Pick the address the nearest trusted proxy appended.
 *
 * Counting from the right is the only safe direction: entries are appended in
 * order, so the right-most is the one added by the hop closest to this process
 * and cannot be forged by anything behind it.
 *
 * @param header - Raw `X-Forwarded-For` value.
 * @param trusted_proxy_hops - Number of trusted proxies.
 * @returns A validated address literal, or null when the header is unusable.
 */
function forwarded_address(header: string | null, trusted_proxy_hops: number): string | null {
  if (header === null || header.length === 0 || header.length > 4_096) return null;
  const entries = header.split(",");
  if (entries.length < trusted_proxy_hops) return null;
  const candidate = entries[entries.length - trusted_proxy_hops]?.trim() ?? "";
  if (candidate.length === 0 || candidate.length > MAX_ADDRESS_CHARS) return null;
  // `isIP` also rejects the bracketless IPv6 forms a proxy would not emit and any
  // value carrying a port or a token, so a malformed entry degrades to the shared
  // bucket instead of becoming its own.
  return isIP(candidate) === 0 ? null : candidate;
}

/** One-way digest of a client address; the address itself is not retained. */
function digest(address: string): string {
  return createHash("sha256").update(address, "utf8").digest("hex").slice(0, KEY_HEX_CHARS);
}
