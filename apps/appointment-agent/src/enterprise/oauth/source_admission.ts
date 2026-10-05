/**
 * Per-source admission control for the authorization entry points.
 *
 * The `state` store is the CSRF control, which means it must mint a record for
 * every request that reaches it. Without a bound on who may mint, one anonymous
 * caller can fill the store by repeating `GET /auth/login`: the store then fails
 * closed for *everybody* for the length of its TTL, which is a denial of
 * service created by a single unauthenticated source rather than by load.
 *
 * The limiter is a token bucket rather than a fixed window for two reasons that
 * matter here. A bucket permits a short legitimate burst (an operator retrying
 * a login, a callback that needs a retry) without letting a sustained flood
 * through, and it refills continuously, so the admission decision for a real
 * operator recovers on its own instead of waiting for a window boundary.
 *
 * Two properties are hard invariants rather than intentions:
 *
 * 1. Bounded memory. The bucket map never exceeds `max_tracked_sources`; a new
 *    source evicts the least recently admitted bucket before it is inserted. An
 *    attacker rotating source keys therefore cannot grow the map without bound,
 *    and the idle sweep is itself bounded so it cannot become the amplifier.
 * 2. Per-source isolation. One source exhausting its bucket never consumes
 *    another's, so a flood degrades to throttling for the flood only. That is
 *    the difference between "degraded" and "locked out".
 *
 * The bucket key is an opaque digest supplied by the caller (see the
 * dashboard's `client_address` module), never a raw address: this map is the one
 * place where a source identity would otherwise be retained in memory.
 */

import { OAuthFlowError } from "./oauth_error.js";

/** Bounded admission settings for one deployment. */
export interface SourceAdmissionPolicy {
  /** Bucket capacity in tokens; the burst a single source may spend at once. */
  burst: number;
  /** Sustained tokens per second a source regains. */
  refill_per_second: number;
  /** Hard upper bound on tracked source buckets. */
  max_tracked_sources: number;
  /** A bucket untouched for this long is reclaimed. */
  idle_evict_seconds: number;
}

/** One bounded admission decision for a single source. */
export interface SourceAdmissionDecision {
  allowed: boolean;
  /** Whole tokens left in the bucket; negative is reported as zero. */
  remaining: number;
  /** Seconds until the next token; always at least 1 so callers can round up. */
  retry_after_seconds: number;
}

/** Defaults chosen for an operator console, not a public sign-up service. */
export const DEFAULT_SOURCE_ADMISSION_POLICY: SourceAdmissionPolicy = Object.freeze({
  burst: 20,
  refill_per_second: 0.5,
  max_tracked_sources: 4_096,
  idle_evict_seconds: 900,
});

/** Environment variable names, kept here so config and limiter cannot disagree. */
export const SOURCE_ADMISSION_ENV = Object.freeze({
  burst: "STAFF_AUTH_ADMISSION_BURST",
  refill_per_second: "STAFF_AUTH_ADMISSION_REFILL_PER_SECOND",
  max_tracked_sources: "STAFF_AUTH_ADMISSION_MAX_SOURCES",
  idle_evict_seconds: "STAFF_AUTH_ADMISSION_IDLE_EVICT_SECONDS",
});

const MAX_BURST = 1_000;
const MAX_REFILL_PER_SECOND = 100;
const MAX_REFILL_DECIMALS = 3;
const MIN_TRACKED_SOURCES = 16;
const MAX_TRACKED_SOURCES = 65_536;
const MIN_IDLE_EVICT_SECONDS = 30;
const MAX_IDLE_EVICT_SECONDS = 86_400;
const MAX_SOURCE_KEY_CHARS = 128;
/**
 * Idle buckets examined per admission.
 *
 * The sweep must not become the amplification vector it exists to prevent, so it
 * inspects only the head of the recency order and stops. Full reclamation happens
 * over successive admissions instead of in one unbounded pass.
 */
const IDLE_SCAN_BUDGET = 32;

/** Mutable per-source state. */
interface SourceBucket {
  tokens: number;
  updated_at_ms: number;
}

/**
 * Bounded token-bucket limiter keyed by an opaque source digest.
 *
 * Re-inserting a bucket on every admission keeps `Map` insertion order equal to
 * recency order, which is what makes least-recently-used eviction and the idle
 * sweep a head scan rather than a full sort.
 */
export class SourceAdmissionLimiter {
  private readonly policy: SourceAdmissionPolicy;
  private readonly clock: () => number;
  private readonly buckets = new Map<string, SourceBucket>();

  /**
   * Create a limiter over a validated policy.
   *
   * @param policy - Bounded admission settings.
   * @param options - Optional injectable clock.
   * @throws OAuthFlowError when the policy is outside its documented bounds.
   */
  constructor(policy: SourceAdmissionPolicy, options: { clock?: () => number } = {}) {
    this.policy = require_policy(policy);
    this.clock = options.clock ?? Date.now;
  }

  /**
   * Spend one token for a source, or report when it may try again.
   *
   * @param source_key - Opaque per-source digest; never a raw address.
   * @returns The decision, including whole tokens remaining.
   * @throws OAuthFlowError when the key is missing, oversized, or has control
   * characters, because a key that cannot be bounded is a key that cannot be
   * evicted.
   */
  admit(source_key: string): SourceAdmissionDecision {
    const key = require_source_key(source_key);
    const now_ms = this.clock();
    this.sweep_idle(now_ms);
    const bucket = this.bucket_for(key, now_ms);
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, remaining: Math.floor(bucket.tokens), retry_after_seconds: 0 };
    }
    return {
      allowed: false,
      remaining: 0,
      retry_after_seconds: Math.max(1, Math.ceil((1 - bucket.tokens) / this.policy.refill_per_second)),
    };
  }

  /**
   * Number of tracked source buckets.
   *
   * Exposed so the bound is assertable rather than assumed.
   *
   * @returns The current bucket count.
   */
  tracked_source_count(): number {
    return this.buckets.size;
  }

  /** Load or create a bucket, reclaiming space when the bound is reached. */
  private bucket_for(key: string, now_ms: number): SourceBucket {
    const existing = this.buckets.get(key);
    if (existing !== undefined) return this.refilled(existing, now_ms);
    if (this.buckets.size >= this.policy.max_tracked_sources) this.evict_oldest();
    return { tokens: this.policy.burst, updated_at_ms: now_ms };
  }

  /** Credit elapsed time to a bucket, clamped to the burst ceiling. */
  private refilled(bucket: SourceBucket, now_ms: number): SourceBucket {
    const elapsed_ms = now_ms - bucket.updated_at_ms;
    if (!Number.isFinite(elapsed_ms) || elapsed_ms <= 0) return bucket;
    const earned = (elapsed_ms / 1_000) * this.policy.refill_per_second;
    return {
      tokens: Math.min(this.policy.burst, bucket.tokens + earned),
      updated_at_ms: now_ms,
    };
  }

  /** Drop the least recently admitted bucket to keep the map inside its bound. */
  private evict_oldest(): void {
    const oldest = this.buckets.keys().next();
    if (oldest.done !== true) this.buckets.delete(oldest.value);
  }

  /** Reclaim a bounded number of idle buckets from the head of the recency order. */
  private sweep_idle(now_ms: number): void {
    const idle_after_ms = this.policy.idle_evict_seconds * 1_000;
    for (let examined = 0; examined < IDLE_SCAN_BUDGET; examined += 1) {
      const oldest = this.buckets.entries().next();
      if (oldest.done === true) return;
      const [key, bucket] = oldest.value;
      if (now_ms - bucket.updated_at_ms <= idle_after_ms) return;
      this.buckets.delete(key);
    }
  }
}

/**
 * Resolve the admission policy from the environment.
 *
 * An absent value keeps the default; a value that is present but outside its
 * bounds is a configuration error rather than a silent fallback, so an operator
 * cannot believe a limit is in force when the value they set was ignored.
 *
 * @param env - Environment mapping; defaults to the process environment.
 * @returns A validated policy.
 * @throws OAuthFlowError when any present value is malformed or out of range.
 */
export function parse_source_admission_policy(
  env: Record<string, string | undefined> = process.env,
): SourceAdmissionPolicy {
  return {
    burst: integer_setting(env[SOURCE_ADMISSION_ENV.burst], SOURCE_ADMISSION_ENV.burst, 1, MAX_BURST),
    refill_per_second: decimal_setting(
      env[SOURCE_ADMISSION_ENV.refill_per_second],
      SOURCE_ADMISSION_ENV.refill_per_second,
      0.001,
      MAX_REFILL_PER_SECOND,
    ),
    max_tracked_sources: integer_setting(
      env[SOURCE_ADMISSION_ENV.max_tracked_sources],
      SOURCE_ADMISSION_ENV.max_tracked_sources,
      MIN_TRACKED_SOURCES,
      MAX_TRACKED_SOURCES,
    ),
    idle_evict_seconds: integer_setting(
      env[SOURCE_ADMISSION_ENV.idle_evict_seconds],
      SOURCE_ADMISSION_ENV.idle_evict_seconds,
      MIN_IDLE_EVICT_SECONDS,
      MAX_IDLE_EVICT_SECONDS,
    ),
  };
}

/** Validate a policy supplied directly rather than through the environment. */
function require_policy(policy: SourceAdmissionPolicy): SourceAdmissionPolicy {
  if (typeof policy !== "object" || policy === null) throw new OAuthFlowError("oauth_configuration_invalid");
  const burst = policy.burst;
  const refill = policy.refill_per_second;
  const sources = policy.max_tracked_sources;
  const idle = policy.idle_evict_seconds;
  if (
    !Number.isSafeInteger(burst) ||
    burst < 1 ||
    burst > MAX_BURST ||
    typeof refill !== "number" ||
    !Number.isFinite(refill) ||
    refill <= 0 ||
    refill > MAX_REFILL_PER_SECOND ||
    !Number.isSafeInteger(sources) ||
    sources < MIN_TRACKED_SOURCES ||
    sources > MAX_TRACKED_SOURCES ||
    !Number.isSafeInteger(idle) ||
    idle < MIN_IDLE_EVICT_SECONDS ||
    idle > MAX_IDLE_EVICT_SECONDS
  ) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  return { burst, refill_per_second: refill, max_tracked_sources: sources, idle_evict_seconds: idle };
}

/** Read an integer setting, defaulting when absent. */
function integer_setting(raw: string | undefined, name: string, min: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return default_for(name);
  if (!/^\d+$/.test(raw.trim())) throw new OAuthFlowError("oauth_configuration_invalid");
  const parsed = Number(raw.trim());
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  return parsed;
}

/** Read a positive decimal setting with a bounded number of decimal places. */
function decimal_setting(raw: string | undefined, name: string, min: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return default_for(name);
  const text = raw.trim();
  if (!/^\d+(\.\d{1,3})?$/.test(text)) throw new OAuthFlowError("oauth_configuration_invalid");
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  return parsed;
}

/** The default matching one setting name. */
function default_for(name: string): number {
  switch (name) {
    case SOURCE_ADMISSION_ENV.burst:
      return DEFAULT_SOURCE_ADMISSION_POLICY.burst;
    case SOURCE_ADMISSION_ENV.refill_per_second:
      return DEFAULT_SOURCE_ADMISSION_POLICY.refill_per_second;
    case SOURCE_ADMISSION_ENV.max_tracked_sources:
      return DEFAULT_SOURCE_ADMISSION_POLICY.max_tracked_sources;
    default:
      return DEFAULT_SOURCE_ADMISSION_POLICY.idle_evict_seconds;
  }
}

/** Require a bounded, printable source key; the value is never logged. */
function require_source_key(source_key: string): string {
  if (
    typeof source_key !== "string" ||
    source_key.length === 0 ||
    source_key.length > MAX_SOURCE_KEY_CHARS ||
    /[\u0000-\u001f\u007f]/u.test(source_key)
  ) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  return source_key;
}
