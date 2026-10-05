/**
 * Minting and field validation for authorization `state` records.
 *
 * The shape rules for a state — purpose, provider, tenant, return path, PKCE
 * verifier, nonce, entropy, TTL — are security controls, not storage concerns.
 * They live here rather than inside any one store so that every store accepts
 * exactly the same records: a durable adapter validating its own copies would mean
 * "malformed" answers two different questions depending on which instance happened
 * to serve the callback.
 *
 * The derivation of the storage key lives in `oauth_state` next to the record it
 * identifies rather than here, because it is a storage concern; both are exported so
 * no adapter re-implements either.
 */

import { createHash, randomBytes } from "node:crypto";
import { OAuthFlowError } from "./oauth_error.js";
import type { OAuthFlowPurpose, OAuthStateRecord, StaffIdentityProvider } from "./oauth_state.js";

/** Default lifetime of a state record. */
export const DEFAULT_OAUTH_STATE_TTL_SECONDS = 300;

/** Longest lifetime a deployment may configure. */
export const MAX_OAUTH_STATE_TTL_SECONDS = 600;

const STATE_ENTROPY_BYTES = 32;
const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const RETURN_PATH_PATTERN = /^\/[A-Za-z0-9][A-Za-z0-9/_-]{0,127}$/;
const MAX_NONCE_CHARS = 256;
const MIN_VERIFIER_CHARS = 43;
const MAX_VERIFIER_CHARS = 128;

/**
 * Mints and validates state records.
 *
 * One minter per store keeps the clock and the entropy source injectable, which is
 * what lets a test drive expiry deterministically and what keeps a store's records
 * all carrying the same TTL — the property the time-ordered sweep depends on.
 */
export class OAuthStateMinter {
  /** Lifetime applied to each record, shared so a store can bound expiry checks. */
  readonly ttl_ms: number;
  private readonly clock: () => number;
  private readonly random: () => Buffer;

  /**
   * Create a minter.
   *
   * @param options - Optional clock, entropy source, and TTL override.
   * @throws OAuthFlowError when the TTL or entropy source is unusable.
   */
  constructor(options: { clock?: () => number; ttl_seconds?: number; random?: () => Buffer } = {}) {
    this.clock = options.clock ?? Date.now;
    this.ttl_ms = bounded_ttl_ms(options.ttl_seconds ?? DEFAULT_OAUTH_STATE_TTL_SECONDS);
    this.random = options.random ?? (() => randomBytes(STATE_ENTROPY_BYTES));
    if (typeof this.random !== "function") throw new OAuthFlowError("oauth_configuration_invalid");
  }

  /**
   * Build and validate one pending record.
   *
   * @param input - Untrusted issuance input from a route handler.
   * @returns The record to persist plus the raw state, which is returned to the
   * caller exactly once and never written to storage.
   * @throws OAuthFlowError when any field is malformed.
   */
  build(input: {
    purpose: OAuthFlowPurpose;
    idp: StaffIdentityProvider;
    tenant_id: string | null;
    return_path: string;
    code_verifier: string;
    nonce: string;
  }): { record: OAuthStateRecord; state: string } {
    const purpose = require_purpose(input?.purpose);
    const idp = require_idp(input?.idp);
    const return_path = require_return_path(input?.return_path);
    if (typeof input?.code_verifier !== "string" || input.code_verifier.length < MIN_VERIFIER_CHARS
      || input.code_verifier.length > MAX_VERIFIER_CHARS) {
      throw new OAuthFlowError("oauth_pkce_invalid");
    }
    if (typeof input.nonce !== "string" || input.nonce.length < 16 || input.nonce.length > MAX_NONCE_CHARS) {
      throw new OAuthFlowError("oauth_configuration_invalid");
    }
    const issued_at_ms = this.clock();
    const state = this.mint();
    return {
      state,
      record: {
        state_hash: hash_state(state),
        purpose,
        idp,
        tenant_id: input.tenant_id === null || input.tenant_id === undefined ? null : require_tenant_id(input.tenant_id),
        return_path,
        code_verifier: input.code_verifier,
        nonce: input.nonce,
        issued_at_ms,
        expires_at_ms: issued_at_ms + this.ttl_ms,
        consumed_at_ms: null,
      },
    };
  }

  /** Generate one 256-bit state value as unpadded base64url. */
  private mint(): string {
    const entropy = this.random();
    if (!(entropy instanceof Buffer) || entropy.byteLength !== STATE_ENTROPY_BYTES) {
      throw new OAuthFlowError("oauth_configuration_invalid");
    }
    return entropy.toString("base64url");
  }
}

/**
 * Validate the shape of a callback `state` value before any storage lookup.
 *
 * Shared by every state-store adapter so a durable adapter cannot accept a
 * different shape from the in-memory one.
 *
 * @param raw_state - Untrusted `state` value from the callback query.
 * @returns The validated value.
 * @throws OAuthFlowError `oauth_state_missing` when absent or not a string, and
 * `oauth_state_malformed` when it does not match the issued shape.
 */
export function require_state_value(raw_state: unknown): string {
  if (typeof raw_state !== "string" || raw_state.length === 0) {
    throw new OAuthFlowError("oauth_state_missing");
  }
  if (!STATE_PATTERN.test(raw_state)) throw new OAuthFlowError("oauth_state_malformed");
  return raw_state;
}

/** Local copy of the key derivation, re-exported by `oauth_state` as the single source. */
function hash_state_shape(raw_state: string): string {
  return raw_state;
}


/**
 * SHA-256 hex of a raw state value; the raw value is never stored.
 *
 * This is the storage key for every adapter, so it lives with the value rules
 * rather than with any one store: a durable adapter that derived keys differently
 * would fail to find records the in-memory store had written, and the symptom would
 * be a login that silently never completes.
 *
 * @param raw_state - Validated raw state value.
 * @returns The lowercase hex digest used as the storage key.
 */
export function hash_state(raw_state: string): string {
  return createHash("sha256").update(raw_state, "utf8").digest("hex");
}

/** Validate a TTL in seconds against the lifetime bounds. */
function bounded_ttl_ms(ttl_seconds: number): number {
  if (
    !Number.isSafeInteger(ttl_seconds) ||
    ttl_seconds < 30 ||
    ttl_seconds > MAX_OAUTH_STATE_TTL_SECONDS
  ) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  return ttl_seconds * 1_000;
}

/** Accept one of the two flow purposes or refuse. */
function require_purpose(value: unknown): OAuthFlowPurpose {
  if (value !== "staff_login" && value !== "calendar_consent") {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  return value;
}

/** Accept one of the two identity providers or refuse. */
function require_idp(value: unknown): StaffIdentityProvider {
  if (value !== "supabase" && value !== "google") throw new OAuthFlowError("oauth_idp_unknown");
  return value;
}

/** Require a positive-integer tenant id without echoing it. */
function require_tenant_id(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9]\d{0,18}$/.test(value)) {
    throw new OAuthFlowError("oauth_tenant_mismatch");
  }
  return value;
}

/**
 * Require an allow-listed relative return path.
 *
 * Re-checked here as well as in `redirect_policy`, because this value is persisted:
 * a shape that navigates somewhere else must never reach storage.
 *
 * @param value - Browser-supplied return path.
 * @returns The validated path.
 * @throws OAuthFlowError when the path is absolute, traversing, or off-origin.
 */
function require_return_path(value: unknown): string {
  if (typeof value !== "string" || !RETURN_PATH_PATTERN.test(value)) {
    throw new OAuthFlowError("oauth_return_path_invalid");
  }
  if (value.includes("//") || value.includes("..") || value.includes("\\") || value.endsWith("/")) {
    throw new OAuthFlowError("oauth_return_path_invalid");
  }
  return value;
}
