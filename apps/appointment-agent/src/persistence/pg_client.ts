/** pg-backed SQL client with bounded pool configuration. */

import { Pool } from "pg";
import type { SqlClient, SqlQueryResult } from "./sql_client.js";

/** Minimal pool surface used by the client and deterministic tests. */
export interface PgPoolLike {
  query(sql: string, values?: readonly unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null }>;
  end(): Promise<void>;
}

/** Safe failure at the database client boundary. */
export class PgClientError extends Error {
  /** Create a safe database error. */
  constructor(reason = "postgres-client-failed", cause?: unknown) {
    super(reason, cause === undefined ? undefined : { cause });
    this.name = "PgClientError";
  }
}

/** Environment-backed pg pool settings. */
export interface PgClientConfig {
  connection_string?: string;
  statement_timeout_ms: number;
  application_name: string;
  max_pool_size: number;
}

/** Constructor options for PgSqlClient. */
export interface PgSqlClientOptions extends Partial<PgClientConfig> {
  /** Inject a pool for unit tests; otherwise a pg Pool is created. */
  pool?: PgPoolLike;
}

/**
 * Load bounded pg settings from environment variables.
 *
 * @param env - Environment mapping; defaults to process.env.
 * @returns Validated pool settings without exposing the connection string.
 * @throws PgClientError when a numeric setting is invalid.
 */
export function load_pg_config(
  env: Record<string, string | undefined> = process.env,
): PgClientConfig {
  const statement_timeout_ms = parse_positive_integer(
    env["PG_STATEMENT_TIMEOUT_MS"] ?? env["DATABASE_STATEMENT_TIMEOUT_MS"] ?? "10000",
    "PG_STATEMENT_TIMEOUT_MS",
  );
  const max_pool_size = parse_positive_integer(
    env["PG_POOL_MAX"] ?? env["DATABASE_POOL_MAX"] ?? "10",
    "PG_POOL_MAX",
  );
  const application_name = env["PG_APPLICATION_NAME"] ?? env["DATABASE_APPLICATION_NAME"] ?? "sela-appointment-agent";
  if (application_name.trim() === "" || application_name.length > 128) {
    throw new PgClientError("postgres-application-name-invalid");
  }
  return {
    connection_string: env["DATABASE_URL"],
    statement_timeout_ms,
    application_name,
    max_pool_size,
  };
}

/** SQL client backed by a configured pg Pool. */
export class PgSqlClient implements SqlClient {
  private readonly pool: PgPoolLike;
  private is_closed = false;

  /**
   * Create a client from explicit options or an injected pool.
   *
   * @param options - Pool settings and optional test pool.
   * @throws PgClientError when no connection string or pool is supplied.
   */
  constructor(options: PgSqlClientOptions = {}) {
    const statement_timeout_ms = positive_integer(
      options.statement_timeout_ms ?? 10_000,
      "statement_timeout_ms",
    );
    const application_name = options.application_name ?? "sela-appointment-agent";
    if (application_name.trim() === "" || application_name.length > 128) {
      throw new PgClientError("postgres-application-name-invalid");
    }
    const max_pool_size = positive_integer(options.max_pool_size ?? 10, "max_pool_size");
    if (options.pool !== undefined) {
      this.pool = options.pool;
      return;
    }
    const connection_string = options.connection_string;
    if (typeof connection_string !== "string" || connection_string.trim() === "") {
      throw new PgClientError("postgres-connection-string-missing");
    }
    this.pool = new Pool({
      connectionString: connection_string,
      statement_timeout: statement_timeout_ms,
      application_name: application_name,
      max: max_pool_size,
    });
  }

  /**
   * Execute one parameterized query.
   *
   * @param sql - SQL text owned by the adapter, never concatenated input.
   * @param values - Bound parameter values.
   * @returns Normalized pg rows and row count.
   * @throws PgClientError when the driver rejects the query.
   */
  async query(sql: string, values?: readonly unknown[]): Promise<SqlQueryResult> {
    if (this.is_closed) throw new PgClientError("postgres-client-closed");
    try {
      const result = await this.pool.query(sql, values);
      return { rows: result.rows, rowCount: result.rowCount };
    } catch (error) {
      throw new PgClientError("postgres-query-failed", error);
    }
  }

  /**
   * Close the pool once; repeated calls are harmless.
   *
   * @returns Nothing.
   * @throws PgClientError when pool shutdown fails.
   */
  async close(): Promise<void> {
    if (this.is_closed) return;
    this.is_closed = true;
    try {
      await this.pool.end();
    } catch (error) {
      throw new PgClientError("postgres-close-failed", error);
    }
  }
}

function parse_positive_integer(value: string, field_name: string): number {
  if (!/^\d+$/.test(value)) throw new PgClientError(`${field_name}-invalid`);
  return positive_integer(Number(value), field_name);
}

function positive_integer(value: number, field_name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 120_000) {
    throw new PgClientError(`${field_name}-invalid`);
  }
  return value;
}
