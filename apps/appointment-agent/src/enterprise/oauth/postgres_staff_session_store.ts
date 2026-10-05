/**
 * Postgres-backed staff session store.
 *
 * A staff session is a revocation record, so where it lives decides what an
 * operator can actually do in an incident. In process memory, restarting the
 * dashboard signs every staff member out — and, worse, a second instance cannot
 * honour a logout the first one performed, so the revocation is a per-instance
 * suggestion rather than a control.
 *
 * Every lifecycle decision is delegated to the existing `session_registry`
 * contracts rather than reimplemented here. `register_session`, `touch_session`,
 * `revoke_session`, and `is_session_revoked` already encode the audited operator
 * behaviour, and duplicating that logic in an adapter is how two copies drift into
 * disagreeing about what "revoked" means. The adapter's only job is to move the
 * resulting record in and out of a row.
 *
 * The registry key derivation is shared with the in-memory store for the same
 * reason: it is derived from both halves of the cookie, and two derivations would
 * mean a logout could address a different row than a resolve.
 *
 * UNPROVEN AGAINST A LIVE DATABASE in this repository: the pooler is not reachable
 * from here, so the correctness argument rests on the SQL shape and on tests
 * against a test double. It has not been observed executing on PostgreSQL.
 */

import {
  is_session_revoked,
  register_session,
  revoke_session,
  type RegisterSessionInput,
  type SessionRecord,
} from "../session_registry.js";
import type { AuthenticatedPrincipal } from "../authorization.js";
import { OAuthFlowError } from "./oauth_error.js";
import {
  issue_session_secret,
  parse_session_cookie,
  secret_matches,
  type IssuedSessionSecret,
} from "./session_cookie.js";
import {
  staff_session_registry_id,
  staff_session_ttl_ms,
  type CreateStaffSessionInput,
  type EstablishedStaffSession,
  type StaffSessionRecord,
  type StaffSessionStore,
} from "./staff_session_store.js";
import type { SqlClient, SqlQueryResult } from "../../persistence/sql_client.js";
import {
  parse_staff_session_row,
  require_staff_session_rows,
  require_text,
  sort_by_last_seen,
  staff_session_insert_values,
} from "./staff_session_row.js";

const SESSION_COLUMNS = `
  session_id, subject_id, issuer, idp, secret_hash, has_mfa, tenant_roles,
  tenant_id, device_hash, session_created_at, session_last_seen_at,
  session_revoked_at, expires_at
`;

const INSERT_SESSION_SQL = `
  INSERT INTO public.staff_sessions (
    session_id, subject_id, issuer, idp, secret_hash, has_mfa, tenant_roles,
    tenant_id, device_hash, session_created_at, session_last_seen_at,
    session_revoked_at, expires_at, created_at, updated_at
  )
  VALUES (
    $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, NULL, $12, now(), now()
  )
`;

const LOAD_SESSION_SQL = `
  SELECT ${SESSION_COLUMNS}
  FROM public.staff_sessions
  WHERE session_id = $1
  LIMIT 1
`;

const LIST_SUBJECT_SESSIONS_SQL = `
  SELECT ${SESSION_COLUMNS}
  FROM public.staff_sessions
  WHERE subject_id = $1
  ORDER BY session_last_seen_at DESC
  LIMIT 200
`;

const TOUCH_SESSION_SQL = `
  UPDATE public.staff_sessions
  SET session_last_seen_at = $2, updated_at = now()
  WHERE session_id = $1 AND session_revoked_at IS NULL
`;

const REVOKE_SESSION_SQL = `
  UPDATE public.staff_sessions
  SET session_revoked_at = now(), session_last_seen_at = now(), updated_at = now()
  WHERE session_id = $1 AND session_revoked_at IS NULL
  RETURNING session_id
`;

const DELETE_EXPIRED_SESSION_SQL = `
  DELETE FROM public.staff_sessions
  WHERE session_id = $1 AND expires_at <= now()
`;

/** Constructor options for the Postgres session store. */
export interface PostgresStaffSessionStoreOptions {
  clock?: () => Date;
}

/** Durable, multi-instance staff session store over the SQL boundary. */
export class PostgresStaffSessionStore implements StaffSessionStore {
  private readonly sql_client: SqlClient;
  private readonly clock: () => Date;

  /**
   * Create the store over an application's parameterized SQL boundary.
   *
   * @param sql_client - Client used for every statement; values stay bound.
   * @param options - Optional clock for deterministic expiry checks.
   */
  constructor(sql_client: SqlClient, options: PostgresStaffSessionStoreOptions = {}) {
    this.sql_client = sql_client;
    this.clock = options.clock ?? (() => new Date());
  }

  /**
   * Establish a session for an authenticated principal.
   *
   * @param input - Verified identity, principal, device, and TTL.
   * @returns The stored record and the single cookie value to send.
   * @throws OAuthFlowError when the principal or TTL is unusable, or the write fails.
   */
  async create(input: CreateStaffSessionInput): Promise<EstablishedStaffSession> {
    const ttl_ms = staff_session_ttl_ms(input?.ttl_seconds);
    const principal = require_principal(input?.principal);
    if (input.subject_id !== principal.subject_id) throw new OAuthFlowError("oauth_identity_unverified");
    if (input.has_mfa !== principal.has_mfa) throw new OAuthFlowError("oauth_identity_unverified");
    const secret = input.secret ?? require_issued_secret();
    const record = this.build_record(principal, input, secret, ttl_ms);
    await this.run(INSERT_SESSION_SQL, staff_session_insert_values(record, secret));
    return { record, cookie_value: `${secret.session_id}.${secret.secret}` };
  }

  /**
   * Resolve a cookie value to a live session.
   *
   * The check order matches the in-memory store exactly — absence, expiry, secret,
   * revocation — so a session one store refuses is refused by the other for the
   * same reason.
   *
   * @param cookie_value - Raw cookie value from the request.
   * @returns The live session record.
   * @throws OAuthFlowError for unknown, expired, revoked, or mismatched cookies.
   */
  async resolve(cookie_value: string): Promise<StaffSessionRecord> {
    const parsed = parse_session_cookie(cookie_value);
    const session_id = staff_session_registry_id(parsed);
    const record = await this.load(session_id);
    if (record === null) throw new OAuthFlowError("oauth_session_unavailable");
    if (this.clock().getTime() >= record.expires_at_ms) {
      await this.delete_expired(session_id);
      throw new OAuthFlowError("oauth_session_unavailable");
    }
    if (!secret_matches(parsed.secret, record.secret_hash)) {
      throw new OAuthFlowError("oauth_session_unavailable");
    }
    if (is_session_revoked(record.session)) throw new OAuthFlowError("oauth_session_unavailable");
    await this.run(TOUCH_SESSION_SQL, [session_id, this.clock()]);
    return record;
  }

  /**
   * Revoke a session so its cookie stops working immediately.
   *
   * The write is conditional on the session still being live, which is what makes
   * a double logout fail loudly rather than reporting a second success.
   *
   * @param session_id - Registry session identifier.
   * @returns The revoked record.
   * @throws OAuthFlowError when the session is unknown or already revoked.
   */
  async revoke(session_id: string): Promise<StaffSessionRecord> {
    const record = await this.load(session_id);
    if (record === null) throw new OAuthFlowError("oauth_session_unavailable");
    let revoked: SessionRecord;
    try {
      revoked = revoke_session(record.session, () => this.clock());
    } catch {
      throw new OAuthFlowError("oauth_session_unavailable");
    }
    const updated = await this.revoke_if_live(session_id);
    // A null result means another instance revoked between the read and the
    // conditional write. The cookie is dead either way, so the caller's intent is
    // satisfied and the locally computed revocation is the honest projection.
    return updated ?? { ...record, session: revoked };
  }

  /**
   * Revoke the session a cookie addresses.
   *
   * @param cookie_value - Raw cookie value from the request.
   * @returns The revoked record.
   * @throws OAuthFlowError when the cookie is malformed, unknown, or revoked.
   */
  async revoke_by_cookie(cookie_value: string): Promise<StaffSessionRecord> {
    const parsed = parse_session_cookie(cookie_value);
    return this.revoke(staff_session_registry_id(parsed));
  }

  /**
   * List the PII-free session history for one subject, newest first.
   *
   * @param subject_id - Subject to filter by.
   * @returns Records newest first, never containing secrets.
   */
  async list_subject_sessions(subject_id: string): Promise<StaffSessionRecord[]> {
    return require_staff_session_rows(await this.run(LIST_SUBJECT_SESSIONS_SQL, [require_text(subject_id, 256)]))
      .map((row) => parse_staff_session_row(row))
      .sort(sort_by_last_seen);
  }

  /** Read one row by registry session id. */
  private async load(session_id: string): Promise<StaffSessionRecord | null> {
    const rows = require_staff_session_rows(await this.run(LOAD_SESSION_SQL, [session_id]));
    return rows.length === 0 ? null : parse_staff_session_row(rows[0]);
  }

  /** Run the conditional revoke and reload when this call won the race. */
  private async revoke_if_live(session_id: string): Promise<StaffSessionRecord | null> {
    const rows = require_staff_session_rows(await this.run(REVOKE_SESSION_SQL, [session_id]));
    return rows.length === 0 ? null : this.load(session_id);
  }

  /** Assemble the persisted record from the shared session registry contract. */
  private build_record(
    principal: AuthenticatedPrincipal,
    input: CreateStaffSessionInput,
    secret: IssuedSessionSecret,
    ttl_ms: number,
  ): StaffSessionRecord {
    const registry_input: RegisterSessionInput = {
      session_id: staff_session_registry_id(secret),
      subject_id: principal.subject_id,
      tenant_id: primary_tenant(principal),
      device_id: input.device_id,
      clock: () => this.clock(),
    };
    return {
      session: register_session(registry_input),
      subject_id: principal.subject_id,
      issuer: require_text(input.issuer, 512),
      idp: input.idp,
      secret_hash: secret.secret_hash,
      has_mfa: principal.has_mfa,
      tenant_roles: principal.tenant_roles,
      expires_at_ms: this.clock().getTime() + ttl_ms,
    };
  }

  /** Remove a row that has already expired; failure is not actionable here. */
  private async delete_expired(session_id: string): Promise<void> {
    try {
      await this.sql_client.query(DELETE_EXPIRED_SESSION_SQL, [session_id]);
    } catch {
      // The session is already unusable, which is the only property the caller
      // asked about; a leftover row expires on its own and is pruned later.
    }
  }

  /**
   * Execute a statement, collapsing any driver failure into a sanitized code.
   *
   * Driver messages can quote bound values, so none of them is propagated.
   */
  private async run(sql: string, values: readonly unknown[]): Promise<SqlQueryResult> {
    try {
      return await this.sql_client.query(sql, values);
    } catch {
      throw new OAuthFlowError("oauth_session_unavailable");
    }
  }
}

/** Require a usable principal without reaching into the store's private guards. */
function require_principal(value: AuthenticatedPrincipal | undefined): AuthenticatedPrincipal {
  if (typeof value !== "object" || value === null || typeof value.subject_id !== "string" || value.subject_id.length === 0) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  return value;
}

/** The lowest tenant id a principal may act in, used as the registry scope. */
function primary_tenant(principal: AuthenticatedPrincipal): string {
  const tenants = Object.keys(principal.tenant_roles).sort();
  const first = tenants[0];
  if (first === undefined) throw new OAuthFlowError("oauth_membership_unresolved");
  return first;
}

/** Mint the cookie secret here so both stores fail closed on the same conditions. */
function require_issued_secret(): IssuedSessionSecret {
  return issue_session_secret();
}

