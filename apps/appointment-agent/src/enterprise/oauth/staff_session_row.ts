/**
 * Row mapping and column validation for durable staff sessions.
 *
 * This is the multi-tenant tamper surface: everything here turns a database row
 * into the record the authorization contracts accept, so the rule it follows is
 * that an unreadable row must fail rather than arrive as a partially populated
 * principal. A row missing a role map, carrying a `has_mfa` that is not a boolean,
 * or naming a device hash that is not a digest is refused outright — silently
 * dropping the field instead would produce a session that looks live and authorizes
 * less than it should, which is the harder failure to notice.
 *
 * Kept apart from the adapter so the SQL and the parsing can be read, and changed,
 * independently.
 */

import { OAuthFlowError } from "./oauth_error.js";
import type { StaffSessionRecord } from "./staff_session_store.js";
import type { IssuedSessionSecret } from "./session_cookie.js";
import type { SqlQueryResult } from "../../persistence/sql_client.js";

const MAX_TEXT_CHARS = 512;
const MAX_ID_CHARS = 256;
const MAX_ROLE_CHARS = 64;
const MAX_ROLES_PER_TENANT = 16;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const TENANT_PATTERN = /^[1-9]\d{0,18}$/;

/**
 * Project one row into a session record, failing closed on anything malformed.
 *
 * @param value - Raw driver row.
 * @returns The validated record.
 * @throws OAuthFlowError when the row cannot be trusted.
 */
export function parse_staff_session_row(value: unknown): StaffSessionRecord {
  if (typeof value !== "object" || value === null) throw new OAuthFlowError("oauth_session_unavailable");
  const row = value as Record<string, unknown>;
  const idp = row.idp;
  if (idp !== "supabase" && idp !== "google") throw new OAuthFlowError("oauth_session_unavailable");
  if (typeof row.has_mfa !== "boolean") throw new OAuthFlowError("oauth_session_unavailable");
  const secret_hash = row.secret_hash;
  if (typeof secret_hash !== "string" || !HASH_PATTERN.test(secret_hash)) {
    throw new OAuthFlowError("oauth_session_unavailable");
  }
  const session = parse_session_columns(row);
  return {
    session,
    subject_id: session.subject_id,
    issuer: require_text(row.issuer, MAX_TEXT_CHARS),
    idp,
    secret_hash,
    has_mfa: row.has_mfa,
    tenant_roles: parse_tenant_roles(row.tenant_roles),
    expires_at_ms: required_epoch(row.expires_at),
  };
}

/**
 * Bound every column of an insert so no value is concatenated into SQL text.
 *
 * @param record - Record the session registry produced.
 * @param secret - Issued secret whose hash is the only half that is stored.
 * @returns The ordered parameter list for the insert.
 */
export function staff_session_insert_values(record: StaffSessionRecord, secret: IssuedSessionSecret): unknown[] {
  return [
    record.session.session_id,
    record.subject_id,
    record.issuer,
    record.idp,
    secret.secret_hash,
    record.has_mfa,
    JSON.stringify(record.tenant_roles),
    record.session.tenant_id,
    record.session.device_hash,
    record.session.created_at_iso,
    record.session.last_seen_at_iso,
    record.expires_at_ms,
  ];
}

/**
 * Reject a driver result that is not a row array.
 *
 * @param result - Driver result for one statement.
 * @returns The rows, possibly empty.
 * @throws OAuthFlowError when the result is not shaped like a result.
 */
export function require_staff_session_rows(result: SqlQueryResult): unknown[] {
  if (!Array.isArray(result.rows)) throw new OAuthFlowError("oauth_session_unavailable");
  return result.rows;
}

/** Order session history newest first. */
export function sort_by_last_seen(left: StaffSessionRecord, right: StaffSessionRecord): number {
  return right.session.last_seen_at_iso.localeCompare(left.session.last_seen_at_iso);
}

/** Rebuild the shared session registry record from its own columns. */
function parse_session_columns(row: Record<string, unknown>): {
  session_id: string;
  subject_id: string;
  tenant_id: string;
  device_hash: string;
  created_at_iso: string;
  last_seen_at_iso: string;
  revoked_at_iso: string | null;
} {
  return {
    session_id: require_text(row.session_id, MAX_ID_CHARS),
    subject_id: require_text(row.subject_id, MAX_ID_CHARS),
    tenant_id: require_tenant(row.tenant_id),
    device_hash: require_hash(row.device_hash),
    created_at_iso: require_iso(row.session_created_at),
    last_seen_at_iso: require_iso(row.session_last_seen_at),
    revoked_at_iso: nullable_iso(row.session_revoked_at),
  };
}

/** Require a bounded, trimmed string. */
export function require_text(value: unknown, max_chars: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max_chars || value.trim() !== value) {
    throw new OAuthFlowError("oauth_session_unavailable");
  }
  return value;
}

/** Require a positive-integer tenant id. */
function require_tenant(value: unknown): string {
  const text = typeof value === "number" || typeof value === "bigint" ? String(value) : value;
  if (typeof text !== "string" || !TENANT_PATTERN.test(text)) {
    throw new OAuthFlowError("oauth_tenant_mismatch");
  }
  return text;
}

/** Require a SHA-256 hex digest column. */
function require_hash(value: unknown): string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new OAuthFlowError("oauth_session_unavailable");
  }
  return value;
}

/** Require a parseable timestamp column and normalize it to ISO 8601. */
function require_iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "string" && typeof value !== "number") {
    throw new OAuthFlowError("oauth_session_unavailable");
  }
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) throw new OAuthFlowError("oauth_session_unavailable");
  return new Date(parsed).toISOString();
}

/** Read an optional timestamp column. */
function nullable_iso(value: unknown): string | null {
  return value === null || value === undefined ? null : require_iso(value);
}

/** Read an epoch-milliseconds column the driver may return in several forms. */
function required_epoch(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : Date.parse(value);
  }
  throw new OAuthFlowError("oauth_session_unavailable");
}

/**
 * Read the tenant role map, accepting either a JSONB object or JSON text.
 *
 * Role values are re-validated by `session_principal` on the way into the
 * authorization contracts; rejecting an unparseable map here is what stops a
 * corrupt row from being carried around as an empty-but-plausible principal.
 *
 * @param value - Raw `jsonb` column or JSON text.
 * @returns Tenant id to role list.
 * @throws OAuthFlowError when the column is not a usable object.
 */
function parse_tenant_roles(value: unknown): Readonly<Record<string, readonly string[]>> {
  const parsed = typeof value === "string" ? parse_json(value) : value;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new OAuthFlowError("oauth_membership_unresolved");
  }
  const roles: Record<string, readonly string[]> = {};
  for (const [tenant_id, entries] of Object.entries(parsed as Record<string, unknown>)) {
    require_tenant(tenant_id);
    if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_ROLES_PER_TENANT) {
      throw new OAuthFlowError("oauth_membership_unresolved");
    }
    roles[tenant_id] = entries.map((entry) => require_text(entry, MAX_ROLE_CHARS));
  }
  return roles;
}

/** Parse JSON text, refusing rather than propagating a parser message. */
function parse_json(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new OAuthFlowError("oauth_membership_unresolved");
  }
}
