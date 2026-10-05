/**
 * Postgres-backed OAuth `state` store.
 *
 * The in-memory store is correct only while one process serves both the authorize
 * request and its callback. Behind a load balancer the callback frequently lands
 * on a different instance, and a callback that cannot find its state fails as
 * `oauth_state_unknown` — which, from the operator's side, is a login that
 * silently never completes. This adapter removes that dependency by storing the
 * record where every instance reads the same row.
 *
 * Single use is enforced by the database rather than by application sequencing:
 * the claim is one conditional `UPDATE ... WHERE consumed_at IS NULL RETURNING`,
 * so two instances racing on the same `state` produce exactly one winner. A
 * read-then-write pair would leave a window in which both callbacks believe they
 * claimed the record, and that window is the CSRF control.
 *
 * UNPROVEN AGAINST A LIVE DATABASE in this repository: the pooler is not reachable
 * from here, so the correctness argument above rests on the SQL shape and on tests
 * against a test double. It has not been observed executing on PostgreSQL.
 */

import { OAuthFlowError } from "./oauth_error.js";
import {
  hash_state,
  OAuthStateMinter,
  require_state_value,
  type IssueOAuthStateInput,
  type IssuedOAuthState,
  type OAuthStateRecord,
  type OAuthStateStore,
  type StaffIdentityProvider,
} from "./oauth_state.js";
import type { SqlClient, SqlQueryResult } from "../../persistence/sql_client.js";

const INSERT_STATE_SQL = `
  INSERT INTO public.oauth_authorization_states (
    state_hash, purpose, idp, tenant_id, return_path,
    code_verifier, nonce, issued_at, expires_at, consumed_at
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8::double precision / 1000.0), to_timestamp($9::double precision / 1000.0), NULL)
`;

const CLAIM_STATE_SQL = `
  UPDATE public.oauth_authorization_states
  SET consumed_at = to_timestamp($2::double precision / 1000.0)
  WHERE state_hash = $1
    AND consumed_at IS NULL
    AND expires_at > to_timestamp($2::double precision / 1000.0)
  RETURNING state_hash, purpose, idp, tenant_id, return_path,
            code_verifier, nonce, issued_at, expires_at, consumed_at
`;

const CLASSIFY_STATE_SQL = `
  SELECT consumed_at, expires_at
  FROM public.oauth_authorization_states
  WHERE state_hash = $1
  LIMIT 1
`;

const PRUNE_STATE_SQL = `
  DELETE FROM public.oauth_authorization_states
  WHERE expires_at < to_timestamp($1::double precision / 1000.0)
`;

/** Constructor options for the Postgres state store. */
export interface PostgresOAuthStateStoreOptions {
  clock?: () => Date;
  /** TTL override; defaults to the same window the in-memory store uses. */
  ttl_seconds?: number;
}

/** Durable, multi-instance state store over the server-side SQL boundary. */
export class PostgresOAuthStateStore implements OAuthStateStore {
  private readonly sql_client: SqlClient;
  private readonly minter: OAuthStateMinter;
  private readonly clock: () => Date;

  /**
   * Create the store over an application's parameterized SQL boundary.
   *
   * @param sql_client - Client used for every statement; values stay bound.
   * @param options - Optional clock and TTL override for deterministic tests.
   */
  constructor(sql_client: SqlClient, options: PostgresOAuthStateStoreOptions = {}) {
    this.sql_client = sql_client;
    this.clock = options.clock ?? (() => new Date());
    this.minter = new OAuthStateMinter({ clock: () => this.clock().getTime(), ttl_seconds: options.ttl_seconds });
  }

  /**
   * Persist one state record and return its raw value exactly once.
   *
   * No capacity cap applies here: an in-process row count is not a memory bound
   * once the rows live in the database, and refusing issuance on a count would
   * reintroduce exactly the lock-out this store exists to remove. Growth is bound
   * by the admission limiter in front of it and by {@link prune_expired}.
   *
   * @param input - Purpose, IdP, tenant, return path, verifier, and nonce.
   * @returns The raw state value for the redirect.
   * @throws OAuthFlowError when any field is malformed or the write fails.
   */
  async issue(input: IssueOAuthStateInput): Promise<IssuedOAuthState> {
    const minted = this.minter.build(input);
    const record = minted.record;
    try {
      await this.sql_client.query(INSERT_STATE_SQL, [
        record.state_hash,
        record.purpose,
        record.idp,
        record.tenant_id,
        record.return_path,
        record.code_verifier,
        record.nonce,
        record.issued_at_ms,
        record.expires_at_ms,
      ]);
    } catch {
      // The failure reason is not echoed: a driver message can carry the bound
      // verifier or nonce, and those are credentials for the pending exchange.
      throw new OAuthFlowError("oauth_configuration_invalid");
    }
    return { state: minted.state, expires_at_ms: record.expires_at_ms };
  }

  /**
   * Claim one state record exactly once, atomically across instances.
   *
   * @param raw_state - Untrusted `state` value from the callback query.
   * @returns The claimed record with its PKCE verifier and nonce.
   * @throws OAuthFlowError for missing, malformed, unknown, expired, or replayed
   * state, and when the claim query fails.
   */
  async consume(raw_state: unknown): Promise<OAuthStateRecord> {
    const candidate = require_state_value(raw_state);
    const state_hash = hash_state(candidate);
    const now_ms = this.clock().getTime();
    const claimed = await this.claim(state_hash, now_ms);
    if (claimed !== null) return claimed;
    return this.classify_failure(state_hash, now_ms);
  }

  /**
   * Reclaim rows whose replay grace window has closed.
   *
   * Nothing enforces this automatically, so a scheduled job must call it; the
   * table is bounded by row TTL rather than by a cap, which is the trade a shared
   * store makes for surviving a restart.
   *
   * @returns The number of rows removed.
   * @throws OAuthFlowError when the delete fails.
   */
  async prune_expired(): Promise<number> {
    try {
      const result = await this.sql_client.query(PRUNE_STATE_SQL, [this.clock().getTime()]);
      return result.rowCount ?? 0;
    } catch {
      throw new OAuthFlowError("oauth_configuration_invalid");
    }
  }

  /** Run the conditional claim and project the winning row. */
  private async claim(state_hash: string, now_ms: number): Promise<OAuthStateRecord | null> {
    let result: SqlQueryResult;
    try {
      result = await this.sql_client.query(CLAIM_STATE_SQL, [state_hash, now_ms]);
    } catch {
      throw new OAuthFlowError("oauth_configuration_invalid");
    }
    if (!Array.isArray(result.rows) || result.rows.length === 0) return null;
    return parse_state_row(result.rows[0]);
  }

  /**
   * Explain a failed claim without disclosing which condition held.
   *
   * The follow-up read exists only so a replay is still reported as a replay: the
   * update already refused it. Every branch fails closed, and none of them tells
   * an attacker more than "this callback cannot proceed".
   *
   * @param state_hash - SHA-256 hex of the presented value.
   * @param now_ms - Claim time in epoch milliseconds.
   * @throws OAuthFlowError always; the return type is `never`.
   */
  private async classify_failure(state_hash: string, now_ms: number): Promise<never> {
    let result: SqlQueryResult;
    try {
      result = await this.sql_client.query(CLASSIFY_STATE_SQL, [state_hash]);
    } catch {
      throw new OAuthFlowError("oauth_configuration_invalid");
    }
    const row = Array.isArray(result.rows) ? result.rows[0] : undefined;
    if (typeof row !== "object" || row === null) throw new OAuthFlowError("oauth_state_unknown");
    const record = row as Record<string, unknown>;
    if (record.consumed_at !== null && record.consumed_at !== undefined) {
      throw new OAuthFlowError("oauth_state_replayed");
    }
    if (typeof record.expires_at === "number" && now_ms >= record.expires_at) {
      throw new OAuthFlowError("oauth_state_expired");
    }
    // The row exists and is neither claimed nor expired, which means another
    // instance won the claim between the update and this read. Refusing is the
    // only safe answer: this instance does not hold the record it would need.
    throw new OAuthFlowError("oauth_state_unknown");
  }
}

/** Project one row into a state record, failing closed on a malformed row. */
function parse_state_row(value: unknown): OAuthStateRecord {
  if (typeof value !== "object" || value === null) throw new OAuthFlowError("oauth_state_unknown");
  const row = value as Record<string, unknown>;
  const purpose = require_enum(row.purpose, "staff_login", "calendar_consent");
  const idp = require_enum<StaffIdentityProvider>(row.idp, "supabase", "google");
  const return_path = row.return_path;
  const code_verifier = row.code_verifier;
  const nonce = row.nonce;
  const issued_at = required_timestamp(row.issued_at);
  const expires_at = required_timestamp(row.expires_at);
  const consumed_at = nullable_timestamp(row.consumed_at);
  if (
    typeof row.state_hash !== "string" ||
    !/^[0-9a-f]{64}$/.test(row.state_hash) ||
    typeof return_path !== "string" ||
    typeof code_verifier !== "string" ||
    typeof nonce !== "string"
  ) {
    throw new OAuthFlowError("oauth_state_unknown");
  }
  return {
    state_hash: row.state_hash,
    purpose,
    idp,
    tenant_id: nullable_tenant_id(row.tenant_id),
    return_path,
    code_verifier,
    nonce,
    issued_at_ms: issued_at,
    expires_at_ms: expires_at,
    consumed_at_ms: consumed_at,
  };
}

/** Accept one of two closed-vocabulary values or refuse. */
function require_enum<T extends string>(value: unknown, first: T, second: T): T {
  if (value === first) return first;
  if (value === second) return second;
  throw new OAuthFlowError("oauth_state_unknown");
}

/** A tenant is either a positive integer string or absent. */
function nullable_tenant_id(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "string" && /^[1-9]\d{0,18}$/.test(value)) return value;
  throw new OAuthFlowError("oauth_tenant_mismatch");
}

/** Read a `timestamptz` column as epoch milliseconds. */
function required_timestamp(value: unknown): number {
  if (value instanceof Date) return valid_epoch(value.getTime());
  if (typeof value === "number") return valid_epoch(value);
  if (typeof value === "string" && value.trim() !== "") return valid_epoch(Date.parse(value));
  throw new OAuthFlowError("oauth_state_unknown");
}

/** Read a nullable `timestamptz` column as epoch milliseconds. */
function nullable_timestamp(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return required_timestamp(value);
}

/** Reject a timestamp the driver could not represent. */
function valid_epoch(value: number): number {
  if (!Number.isFinite(value)) throw new OAuthFlowError("oauth_state_unknown");
  return value;
}
