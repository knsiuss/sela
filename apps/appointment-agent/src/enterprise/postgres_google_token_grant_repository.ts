/**
 * Postgres-backed grant repository.
 *
 * This adapter is the only component that touches a stored Calendar grant row,
 * and every column it writes is ciphertext. That is the point of the split: a
 * deployment can move grants out of process memory without any code path gaining
 * the ability to persist a plaintext refresh token, because no method here accepts
 * one. The envelope check below is the belt to that braces — if a caller bug ever
 * handed the repository a raw token, the write is refused rather than stored.
 *
 * Decryption stays in the application and stays bound to tenant and purpose by the
 * shared cipher, so a row copied into another tenant still fails the
 * authentication check when it is opened.
 *
 * UNPROVEN AGAINST A LIVE DATABASE in this repository: the pooler is not reachable
 * from here, so the correctness argument rests on the SQL shape and on tests
 * against a test double. It has not been observed executing on PostgreSQL.
 */

import { OAuthFlowError } from "./oauth/oauth_error.js";
import {
  require_grant_tenant_id,
  type GoogleTokenGrant,
  type GoogleTokenGrantRepository,
} from "./oauth/google_grant_repository.js";
import { TENANT_SECRET_CIPHERTEXT_VERSION } from "../security/tenant_secret_cipher.js";
import type { SqlClient, SqlQueryResult } from "../persistence/sql_client.js";

const GRANT_COLUMNS = `
  grant_id, tenant_id, google_subject_id, authorized_by_subject_id,
  scopes, encrypted_refresh_token, created_at, last_used_at, revoked_at
`;

/**
 * Replace the tenant's active grant.
 *
 * One active grant per tenant is a uniqueness property of the row set, so it is
 * enforced by an upsert against a partial unique index rather than by a
 * read-then-write in application code that two instances could interleave.
 */
const REPLACE_GRANT_SQL = `
  INSERT INTO public.google_token_grants AS stored (
    grant_id, tenant_id, google_subject_id, authorized_by_subject_id,
    scopes, encrypted_refresh_token, created_at, last_used_at, revoked_at, updated_at
  )
  VALUES ($1, $2::bigint, $3, $4, $5::text[], $6, $7, NULL, NULL, now())
  ON CONFLICT (tenant_id) WHERE revoked_at IS NULL
  DO UPDATE SET grant_id = EXCLUDED.grant_id,
                google_subject_id = EXCLUDED.google_subject_id,
                authorized_by_subject_id = EXCLUDED.authorized_by_subject_id,
                scopes = EXCLUDED.scopes,
                encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
                created_at = EXCLUDED.created_at,
                last_used_at = NULL,
                revoked_at = NULL,
                updated_at = now()
  RETURNING ${GRANT_COLUMNS}
`;

const LOAD_GRANT_SQL = `
  SELECT ${GRANT_COLUMNS}
  FROM public.google_token_grants
  WHERE tenant_id = $1::bigint
  LIMIT 1
`;

const LIST_GRANTS_SQL = `
  SELECT ${GRANT_COLUMNS}
  FROM public.google_token_grants
  ORDER BY tenant_id
`;

const LIST_TENANT_GRANTS_SQL = `
  SELECT ${GRANT_COLUMNS}
  FROM public.google_token_grants
  WHERE tenant_id = $1::bigint
  ORDER BY tenant_id
`;

const MARK_USED_SQL = `
  UPDATE public.google_token_grants
  SET last_used_at = $2, updated_at = now()
  WHERE tenant_id = $1::bigint AND revoked_at IS NULL
`;

const MARK_UNUSABLE_SQL = `
  UPDATE public.google_token_grants
  SET revoked_at = $2, updated_at = now()
  WHERE tenant_id = $1::bigint AND revoked_at IS NULL
`;

const DELETE_IF_GRANT_SQL = `
  DELETE FROM public.google_token_grants
  WHERE tenant_id = $1::bigint AND grant_id = $2
  RETURNING grant_id
`;

/** Constructor options for the Postgres grant repository. */
export interface PostgresGoogleTokenGrantRepositoryOptions {
  clock?: () => Date;
}

/** Durable, multi-instance grant persistence over the SQL boundary. */
export class PostgresGoogleTokenGrantRepository implements GoogleTokenGrantRepository {
  private readonly sql_client: SqlClient;
  private readonly clock: () => Date;

  /**
   * Create the repository over an application's parameterized SQL boundary.
   *
   * @param sql_client - Client used for every statement; values stay bound.
   * @param options - Optional clock.
   */
  constructor(sql_client: SqlClient, options: PostgresGoogleTokenGrantRepositoryOptions = {}) {
    this.sql_client = sql_client;
    this.clock = options.clock ?? (() => new Date());
  }

  /**
   * Read one tenant's grant, revoked rows included so a revoke stays auditable.
   *
   * @param tenant_id - Tenant whose grant to read.
   * @returns The stored grant, or null when the tenant has none.
   */
  async load(tenant_id: string): Promise<GoogleTokenGrant | null> {
    const rows = require_rows(await this.run(LOAD_GRANT_SQL, [require_grant_tenant_id(tenant_id)]));
    return rows.length === 0 ? null : parse_grant_row(rows[0]);
  }

  /**
   * Insert or replace the tenant's active grant.
   *
   * @param grant - Grant whose refresh token field is already ciphertext.
   * @returns The stored row.
   * @throws OAuthFlowError when the envelope is not a tenant-secret ciphertext or
   * the write fails.
   */
  async replace(grant: GoogleTokenGrant): Promise<GoogleTokenGrant> {
    require_ciphertext(grant?.encrypted_refresh_token);
    const rows = require_rows(await this.run(REPLACE_GRANT_SQL, [
      require_opaque(grant.grant_id),
      require_grant_tenant_id(grant.tenant_id),
      require_opaque(grant.google_subject_id),
      require_opaque(grant.authorized_by_subject_id),
      [...grant.scopes],
      grant.encrypted_refresh_token,
      require_iso(grant.created_at_iso),
    ]));
    return rows.length === 0 ? { ...grant, scopes: [...grant.scopes] } : parse_grant_row(rows[0]);
  }

  /** Stamp last use on the tenant's active grant. */
  async mark_used(tenant_id: string, at_iso: string): Promise<void> {
    await this.run(MARK_USED_SQL, [require_grant_tenant_id(tenant_id), require_iso(at_iso)]);
  }

  /** Mark the tenant's stored grant unusable without removing it. */
  async mark_unusable(tenant_id: string, at_iso: string): Promise<void> {
    await this.run(MARK_UNUSABLE_SQL, [require_grant_tenant_id(tenant_id), require_iso(at_iso)]);
  }

  /**
   * Compare-and-delete the tenant's row against the revoked grant identity.
   *
   * @param tenant_id - Tenant whose row would be retired.
   * @param grant_id - Identity of the grant the caller revoked at the provider.
   * @returns True when the stored row was that grant and is now gone.
   */
  async delete_if(tenant_id: string, grant_id: string): Promise<boolean> {
    const rows = require_rows(await this.run(DELETE_IF_GRANT_SQL, [
      require_grant_tenant_id(tenant_id),
      require_opaque(grant_id),
    ]));
    return rows.length > 0;
  }

  /** List the mapping, oldest tenant first. */
  async list(tenant_id?: string): Promise<GoogleTokenGrant[]> {
    const sql = tenant_id === undefined ? LIST_GRANTS_SQL : LIST_TENANT_GRANTS_SQL;
    const values = tenant_id === undefined ? [] : [require_grant_tenant_id(tenant_id)];
    return require_rows(await this.run(sql, values)).map(parse_grant_row);
  }

  /**
   * Execute a statement, collapsing any driver failure into a sanitized code.
   *
   * Driver messages can quote bound values, which here would include a ciphertext
   * envelope, so none of them is propagated.
   */
  private async run(sql: string, values: readonly unknown[]): Promise<SqlQueryResult> {
    try {
      return await this.sql_client.query(sql, values);
    } catch {
      throw new OAuthFlowError("oauth_configuration_invalid");
    }
  }
}

/**
 * Refuse anything that is not a tenant-secret envelope.
 *
 * The port is already ciphertext-only by construction; this makes a caller bug
 * fail at the boundary instead of writing a live credential into the table.
 *
 * @param value - Candidate ciphertext.
 * @throws OAuthFlowError when the value is not a versioned secret envelope.
 */
function require_ciphertext(value: unknown): void {
  if (typeof value !== "string" || !value.startsWith(`${TENANT_SECRET_CIPHERTEXT_VERSION}.`)) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
}

/** Project one row into a grant, failing closed on a malformed row. */
function parse_grant_row(value: unknown): GoogleTokenGrant {
  if (typeof value !== "object" || value === null) throw new OAuthFlowError("oauth_configuration_invalid");
  const row = value as Record<string, unknown>;
  require_ciphertext(row.encrypted_refresh_token);
  const scopes = row.scopes;
  if (!Array.isArray(scopes) || scopes.length === 0 || scopes.length > 16) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  return {
    grant_id: require_opaque(row.grant_id),
    tenant_id: require_grant_tenant_id(read_tenant(row.tenant_id)),
    google_subject_id: require_opaque(row.google_subject_id),
    authorized_by_subject_id: require_opaque(row.authorized_by_subject_id),
    scopes: scopes.map((scope) => require_opaque(scope)),
    encrypted_refresh_token: row.encrypted_refresh_token as string,
    created_at_iso: require_iso(row.created_at),
    last_used_at_iso: nullable_iso(row.last_used_at),
    revoked_at_iso: nullable_iso(row.revoked_at),
  };
}

/** A `bigint` column arrives as a string from the driver. */
function read_tenant(value: unknown): string {
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "string" && value.trim() !== "") return value;
  throw new OAuthFlowError("oauth_tenant_mismatch");
}

/** Require a bounded, printable identifier without echoing it. */
function require_opaque(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  return value;
}

/** Require a parseable timestamp and normalize it to ISO 8601. */
function require_iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "string" && typeof value !== "number") {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) throw new OAuthFlowError("oauth_configuration_invalid");
  return new Date(parsed).toISOString();
}

/** Read an optional timestamp column. */
function nullable_iso(value: unknown): string | null {
  return value === null || value === undefined ? null : require_iso(value);
}

/** Reject a driver result that is not a row array. */
function require_rows(result: SqlQueryResult): unknown[] {
  if (!Array.isArray(result.rows)) throw new OAuthFlowError("oauth_configuration_invalid");
  return result.rows;
}
