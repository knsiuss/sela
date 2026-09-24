/** pg-backed SQL client with bounded pool and transaction configuration. */

import { Pool } from "pg";
import type {
  SqlQueryResult,
  SqlTransactionClient,
  SqlTransactionWork,
  TransactionalSqlClient,
} from "./sql_client.js";

/** Default bounded timeout for establishing or checking out a pg connection. */
const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;

/** Default wall-clock bound for one complete database transaction. */
export const DEFAULT_TRANSACTION_TIMEOUT_MS = 10_000;

/** Maximum additional wait used to issue ROLLBACK after a failed transaction. */
const MAX_ROLLBACK_TIMEOUT_MS = 1_000;

/** Minimal transaction connection surface used by the client and deterministic tests. */
export interface PgPoolClientLike {
  query(sql: string, values?: readonly unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null }>;
  release(destroy?: boolean | Error): void;
}

/** Minimal pool surface used by the client and deterministic tests. */
export interface PgPoolLike {
  query(sql: string, values?: readonly unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null }>;
  connect?(): Promise<PgPoolClientLike>;
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
  connection_timeout_ms: number;
  transaction_timeout_ms?: number;
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
 * @returns Validated pool and transaction settings without exposing the connection string.
 * @throws PgClientError when a numeric setting is invalid.
 */
export function load_pg_config(
  env: Record<string, string | undefined> = process.env,
): PgClientConfig {
  const statement_timeout_ms = parse_positive_integer(
    env["PG_STATEMENT_TIMEOUT_MS"] ?? env["DATABASE_STATEMENT_TIMEOUT_MS"] ?? "10000",
    "PG_STATEMENT_TIMEOUT_MS",
  );
  const connection_timeout_ms = parse_positive_integer(
    env["PG_CONNECTION_TIMEOUT_MS"] ?? env["DATABASE_CONNECTION_TIMEOUT_MS"] ?? String(DEFAULT_CONNECTION_TIMEOUT_MS),
    "PG_CONNECTION_TIMEOUT_MS",
  );
  const transaction_timeout_ms = parse_positive_integer(
    env["PG_TRANSACTION_TIMEOUT_MS"]
      ?? env["DATABASE_TRANSACTION_TIMEOUT_MS"]
      ?? String(DEFAULT_TRANSACTION_TIMEOUT_MS),
    "PG_TRANSACTION_TIMEOUT_MS",
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
    connection_timeout_ms,
    transaction_timeout_ms,
    application_name,
    max_pool_size,
  };
}

/** SQL client backed by a configured pg Pool. */
export class PgSqlClient implements TransactionalSqlClient {
  private readonly pool: PgPoolLike;
  private readonly statement_timeout_ms: number;
  private readonly transaction_timeout_ms: number;
  private is_closed = false;

  /**
   * Create a client from explicit options or an injected pool.
   *
   * @param options - Pool settings and optional test pool.
   * @throws PgClientError when no connection string or pool is supplied.
   */
  constructor(options: PgSqlClientOptions = {}) {
    this.statement_timeout_ms = positive_integer(
      options.statement_timeout_ms ?? 10_000,
      "statement_timeout_ms",
    );
    const connection_timeout_ms = positive_integer(
      options.connection_timeout_ms ?? DEFAULT_CONNECTION_TIMEOUT_MS,
      "connection_timeout_ms",
    );
    this.transaction_timeout_ms = positive_integer(
      options.transaction_timeout_ms ?? DEFAULT_TRANSACTION_TIMEOUT_MS,
      "transaction_timeout_ms",
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
      statement_timeout: this.statement_timeout_ms,
      connectionTimeoutMillis: connection_timeout_ms,
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
  async query(sql: string, values?: readonly unknown[], signal?: AbortSignal): Promise<SqlQueryResult> {
    if (this.is_closed) throw new PgClientError("postgres-client-closed");
    try {
      const result = signal === undefined
        ? await this.pool.query(sql, values)
        : await query_with_signal(this.pool, sql, values, signal, this.statement_timeout_ms);
      return { rows: result.rows, rowCount: result.rowCount };
    } catch (error) {
      throw new PgClientError("postgres-query-failed", error);
    }
  }

  /**
   * Run one callback on a dedicated connection with bounded transaction time.
   *
   * BEGIN and COMMIT are issued only around the callback. Any callback,
   * control-query, or timeout failure attempts ROLLBACK before releasing the
   * connection. A timed-out connection is destroyed because PostgreSQL may
   * still be finishing a query that was in flight at the deadline.
   *
   * @param work - Transaction-scoped work to execute.
   * @returns The callback result after a successful commit.
   * @throws PgClientError when checkout, the transaction, or release fails.
   */
  async with_transaction<T>(work: SqlTransactionWork<T>, signal?: AbortSignal): Promise<T> {
    if (this.is_closed) throw new PgClientError("postgres-client-closed");
    if (typeof work !== "function") throw new PgClientError("postgres-transaction-callback-invalid");
    if (signal?.aborted) throw new PgClientError("postgres-transaction-aborted");
    const connect = this.pool.connect;
    if (connect === undefined) throw new PgClientError("postgres-transaction-unavailable");

    let connection: PgPoolClientLike;
    try {
      connection = await connect_with_signal(connect, this.pool, signal);
    } catch (error) {
      throw new PgClientError("postgres-transaction-connect-failed", error);
    }

    let attempt: TransactionAttempt<T>;
    try {
      attempt = await execute_transaction(connection, this.transaction_timeout_ms, work, signal);
    } catch (error) {
      try {
        connection.release(true);
      } catch (release_error) {
        throw new PgClientError(
          "postgres-transaction-release-failed",
          new AggregateError([error, release_error], "postgres-transaction-release-failed"),
        );
      }
      if (error instanceof PgClientError) throw error;
      throw new PgClientError("postgres-transaction-failed", error);
    }

    let release_error: unknown;
    try {
      if (attempt.timed_out) connection.release(true);
      else connection.release();
    } catch (error) {
      release_error = error;
    }

    if (!attempt.ok) {
      if (release_error !== undefined) {
        throw new PgClientError(
          "postgres-transaction-release-failed",
          new AggregateError([attempt.error, release_error], "postgres-transaction-release-failed"),
        );
      }
      if (attempt.error instanceof PgClientError) throw attempt.error;
      throw new PgClientError("postgres-transaction-failed", attempt.error);
    }
    if (release_error !== undefined) {
      throw new PgClientError("postgres-transaction-release-failed", release_error);
    }
    return attempt.value;
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

async function connect_with_signal(
  connect: () => Promise<PgPoolClientLike>,
  pool: PgPoolLike,
  signal?: AbortSignal,
): Promise<PgPoolClientLike> {
  if (signal === undefined) return connect.call(pool);
  if (signal.aborted) throw new PgClientError("postgres-transaction-aborted");

  return new Promise<PgPoolClientLike>((resolve, reject) => {
    let settled = false;
    const on_abort = (): void => {
      if (settled) return;
      settled = true;
      reject(new PgClientError("postgres-transaction-aborted"));
    };
    signal.addEventListener("abort", on_abort, { once: true });
    void Promise.resolve()
      .then(() => connect.call(pool))
      .then(
        (connection) => {
          signal.removeEventListener("abort", on_abort);
          if (settled) {
            try {
              connection.release(true);
            } catch {
              // The original cancellation remains the actionable failure.
            }
            return;
          }
          settled = true;
          resolve(connection);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", on_abort);
          if (settled) return;
          settled = true;
          reject(error);
        },
      );
  });
}

async function query_with_signal(
  pool: PgPoolLike,
  sql: string,
  values: readonly unknown[] | undefined,
  signal: AbortSignal,
  timeout_ms: number,
): Promise<{ rows: unknown[]; rowCount?: number | null }> {
  const connect = pool.connect;
  if (connect === undefined) throw new PgClientError("postgres-query-signal-unavailable");
  const connection = await connect_with_signal(connect, pool, signal);
  let should_destroy = false;
  try {
    const result = await run_bounded(
      () => connection.query(sql, values),
      timeout_ms,
      () => {
        should_destroy = true;
      },
      signal,
    );
    return { rows: result.rows, rowCount: result.rowCount };
  } finally {
    try {
      connection.release(should_destroy || signal.aborted);
    } catch (error) {
      throw new PgClientError("postgres-query-release-failed", error);
    }
  }
}

type TransactionAttempt<T> =
  | { ok: true; value: T; timed_out: boolean }
  | { ok: false; error: unknown; timed_out: boolean };

async function execute_transaction<T>(
  connection: PgPoolClientLike,
  timeout_ms: number,
  work: SqlTransactionWork<T>,
  signal?: AbortSignal,
): Promise<TransactionAttempt<T>> {
  let began = false;
  let is_active = true;
  let timed_out = false;
  const transaction_client = create_transaction_client(connection, () => is_active);
  try {
    const value = await run_bounded(
      async () => {
        if (signal?.aborted) throw new PgClientError("postgres-transaction-aborted");
        // Mark the attempt before BEGIN so an ambiguous BEGIN failure still attempts cleanup.
        began = true;
        await control_query(connection, "BEGIN", "postgres-transaction-begin-failed");
        const callback_value = await work(transaction_client);
        await control_query(connection, "COMMIT", "postgres-transaction-commit-failed");
        began = false;
        return callback_value;
      },
      timeout_ms,
      () => {
        timed_out = true;
        is_active = false;
      },
      signal,
    );
    is_active = false;
    return { ok: true, value, timed_out };
  } catch (error) {
    is_active = false;
    const rollback = signal?.aborted
      ? { error, should_destroy: true }
      : await rollback_after_failure(connection, began, error, timeout_ms);
    return {
      ok: false,
      error: rollback.error,
      timed_out: timed_out || rollback.should_destroy,
    };
  }
}

interface RollbackOutcome {
  error: unknown;
  should_destroy: boolean;
}

async function rollback_after_failure(
  connection: PgPoolClientLike,
  began: boolean,
  original_error: unknown,
  transaction_timeout_ms: number,
): Promise<RollbackOutcome> {
  if (!began) return { error: original_error, should_destroy: false };
  try {
    await run_bounded(
      () => connection.query("ROLLBACK"),
      Math.min(transaction_timeout_ms, MAX_ROLLBACK_TIMEOUT_MS),
      () => undefined,
    );
    return { error: original_error, should_destroy: false };
  } catch (rollback_error) {
    return {
      error: new PgClientError(
        "postgres-transaction-rollback-failed",
        new AggregateError([original_error, rollback_error], "postgres-transaction-rollback-failed"),
      ),
      should_destroy: true,
    };
  }
}

function create_transaction_client(
  connection: PgPoolClientLike,
  is_active: () => boolean,
): SqlTransactionClient {
  return {
    async query(sql: string, values?: readonly unknown[]): Promise<SqlQueryResult> {
      if (!is_active()) throw new PgClientError("postgres-transaction-closed");
      try {
        const result = await connection.query(sql, values);
        return { rows: result.rows, rowCount: result.rowCount };
      } catch (error) {
        throw new PgClientError("postgres-query-failed", error);
      }
    },
  };
}

async function control_query(
  connection: PgPoolClientLike,
  sql: string,
  reason: string,
): Promise<void> {
  try {
    await connection.query(sql);
  } catch (error) {
    throw new PgClientError(reason, error);
  }
}

async function run_bounded<T>(
  operation: () => Promise<T>,
  timeout_ms: number,
  on_timeout: () => void,
  signal?: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let on_abort: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      on_timeout();
      reject(new PgClientError("postgres-transaction-timeout"));
    }, timeout_ms);
    if (signal !== undefined) {
      on_abort = (): void => {
        on_timeout();
        reject(new PgClientError("postgres-transaction-aborted"));
      };
      if (signal.aborted) on_abort();
      else signal.addEventListener("abort", on_abort, { once: true });
    }
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (on_abort !== undefined) signal?.removeEventListener("abort", on_abort);
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
