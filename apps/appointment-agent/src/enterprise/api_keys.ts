/** Scoped API keys with expiry, revocation, and rotation. */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { authorize, type AuthenticatedPrincipal, type EnterprisePermission } from "./authorization.js";

/** Scopes are the existing enterprise permissions; no new privilege vocabulary. */
export type ApiKeyScope = EnterprisePermission;

/** Persisted key metadata; the secret itself is never stored. */
export interface ApiKeyRecord {
  key_id: string;
  tenant_id: string;
  scopes: readonly ApiKeyScope[];
  secret_hash: string;
  expires_at_iso: string;
  revoked_at_iso: string | null;
  predecessor_key_id: string | null;
  created_at_iso: string;
}

/** Input for creating a key. */
export interface CreateApiKeyInput {
  tenant_id: string;
  scopes: readonly ApiKeyScope[];
  ttl_days: number;
  clock?: () => Date;
}

/** Issued credential; secret is returned once and never persisted. */
export interface IssuedApiKey {
  record: ApiKeyRecord;
  secret: string;
}

/** Failure with a stable machine-readable code. */
export class ApiKeyError extends Error {
  readonly code: string;

  /** Create a sanitized API key failure. */
  constructor(code: string) {
    super(code);
    this.name = "ApiKeyError";
    this.code = code;
  }
}

const KNOWN_SCOPES: readonly ApiKeyScope[] = Object.freeze([
  "appointments:read", "appointments:reschedule", "appointments:cancel",
  "handoff:read", "outbound:replay", "outbound:status:read",
  "tenant:manage", "audit:read", "analytics:read",
]);

/**
 * Create a scoped key with expiry; returns the secret once.
 *
 * @param input - Tenant, scopes, and TTL.
 * @returns Record plus one-time secret.
 */
export function create_api_key(input: CreateApiKeyInput): IssuedApiKey {
  if (typeof input !== "object" || input === null) throw new ApiKeyError("api-key-invalid");
  require_tenant_id(input.tenant_id);
  const scopes = require_scopes(input.scopes);
  if (!Number.isSafeInteger(input.ttl_days) || input.ttl_days < 1 || input.ttl_days > 365) {
    throw new ApiKeyError("api-key-ttl-invalid");
  }
  const now_ms = (input.clock ?? (() => new Date()))().getTime();
  const key_id = `ak_${randomBytes(8).toString("hex")}`;
  const secret = randomBytes(32).toString("base64url");
  const created = new Date(now_ms).toISOString();
  const record: ApiKeyRecord = {
    key_id, tenant_id: input.tenant_id, scopes,
    secret_hash: hash_secret(secret),
    expires_at_iso: new Date(now_ms + input.ttl_days * 86_400_000).toISOString(),
    revoked_at_iso: null, predecessor_key_id: null, created_at_iso: created,
  };
  return { record, secret };
}

/**
 * Verify a presented secret against its stored hash and policy.
 *
 * @param secret - Presented secret.
 * @param record - Stored metadata.
 * @param now - Clock for expiry checks.
 * @returns The verified record.
 */
export function verify_api_key(secret: string, record: ApiKeyRecord, now: Date = new Date()): ApiKeyRecord {
  const current = require_record(record);
  if (typeof secret !== "string" || secret.length < 16 || secret.length > 512) {
    throw new ApiKeyError("api-key-mismatch");
  }
  if (!constant_time_compare(hash_secret(secret), current.secret_hash)) throw new ApiKeyError("api-key-mismatch");
  if (current.revoked_at_iso !== null) throw new ApiKeyError("api-key-revoked");
  if (Date.parse(current.expires_at_iso) <= now.getTime()) throw new ApiKeyError("api-key-expired");
  return current;
}

/**
 * Revoke a key; terminal.
 *
 * @param record - Stored metadata.
 * @param clock - Optional clock.
 * @returns Revoked record.
 */
export function revoke_api_key(record: ApiKeyRecord, clock: () => Date = () => new Date()): ApiKeyRecord {
  const current = require_record(record);
  if (current.revoked_at_iso !== null) throw new ApiKeyError("api-key-already-revoked");
  return { ...current, revoked_at_iso: clock().toISOString() };
}

/**
 * Rotate a key: issue a successor linked to its predecessor and revoke the old.
 *
 * Both records are returned so the caller can persist them atomically; the
 * old key must never stay active alongside its successor. The link preserves
 * audit continuity.
 *
 * @param old_record - Key being replaced.
 * @param input - Successor scopes and TTL.
 * @returns Revoked predecessor plus successor with its one-time secret.
 */
export function rotate_api_key(old_record: ApiKeyRecord, input: CreateApiKeyInput): {
  revoked: ApiKeyRecord;
  issued: IssuedApiKey;
} {
  const current = require_record(old_record);
  if (current.revoked_at_iso !== null) throw new ApiKeyError("api-key-rotation-revoked");
  if (current.tenant_id !== input.tenant_id) throw new ApiKeyError("api-key-rotation-tenant-mismatch");
  const issued = create_api_key(input);
  return {
    revoked: { ...current, revoked_at_iso: issued.record.created_at_iso },
    issued: {
      record: { ...issued.record, predecessor_key_id: current.key_id },
      secret: issued.secret,
    },
  };
}

/**
 * Authorized rotation endpoint logic: tenant:manage only, then rotate.
 *
 * Returns both the revoked predecessor and the successor so the HTTP layer
 * can persist both atomically.
 *
 * @param principal - Verified principal.
 * @param tenant_id - Owning tenant.
 * @param old_record - Key being replaced.
 * @param input - Successor parameters.
 * @returns Revoked old record plus issued successor.
 */
export function handle_rotate_api_key_request(
  principal: AuthenticatedPrincipal,
  tenant_id: string,
  old_record: ApiKeyRecord,
  input: CreateApiKeyInput,
): { revoked: ApiKeyRecord; issued: IssuedApiKey } {
  authorize(principal, tenant_id, "tenant:manage");
  if (input.tenant_id !== tenant_id) throw new ApiKeyError("api-key-rotation-tenant-mismatch");
  return rotate_api_key(old_record, input);
}

/** In-memory key metadata adapter for tests and explicit local mode. */
export class InMemoryApiKeyStore {
  private readonly rows = new Map<string, ApiKeyRecord>();

  /**
   * Persist issued key metadata.
   *
   * @param record - Metadata to store.
   */
  async save(record: ApiKeyRecord): Promise<void> {
    this.rows.set(require_record(record).key_id, { ...record });
  }

  /**
   * Read metadata by key id.
   *
   * @param key_id - Key identifier.
   * @returns A copy or null.
   */
  async get(key_id: string): Promise<ApiKeyRecord | null> {
    const found = this.rows.get(key_id);
    return found === undefined ? null : { ...found };
  }
}

/**
 * Hash a secret for storage; only digests leave this boundary.
 *
 * @param secret - Raw secret.
 * @returns Hex digest.
 */
export function hash_secret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function require_scopes(value: readonly ApiKeyScope[]): readonly ApiKeyScope[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > KNOWN_SCOPES.length) {
    throw new ApiKeyError("api-key-scopes-invalid");
  }
  const unique = [...new Set(value)];
  if (unique.length !== value.length) throw new ApiKeyError("api-key-scopes-invalid");
  for (const scope of unique) {
    if (!KNOWN_SCOPES.includes(scope)) throw new ApiKeyError("api-key-scope-unknown");
  }
  return Object.freeze(unique);
}

function require_record(value: ApiKeyRecord): ApiKeyRecord {
  if (typeof value !== "object" || value === null) throw new ApiKeyError("api-key-invalid");
  if (typeof value.key_id !== "string" || !/^ak_[0-9a-f]{16}$/.test(value.key_id)) throw new ApiKeyError("api-key-invalid");
  require_tenant_id(value.tenant_id);
  require_scopes(value.scopes);
  if (!/^[0-9a-f]{64}$/.test(value.secret_hash)) throw new ApiKeyError("api-key-invalid");
  return value;
}

function require_tenant_id(value: string): string {
  if (typeof value !== "string" || !/^[1-9]\d{0,18}$/.test(value)) throw new ApiKeyError("api-key-tenant-invalid");
  return value;
}

function constant_time_compare(left: string, right: string): boolean {
  const left_bytes = Buffer.from(left, "utf8");
  const right_bytes = Buffer.from(right, "utf8");
  if (left_bytes.length !== right_bytes.length) return false;
  return timingSafeEqual(left_bytes, right_bytes);
}
