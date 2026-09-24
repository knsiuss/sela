import type { SqlClient, SqlQueryResult } from "../persistence/sql_client.js";
import {
  DedupeStoreError,
  assert_valid_wamid,
} from "./dedupe_contract.js";
import type { MessageDedupeStore } from "./dedupe.js";

export type { SqlClient, SqlQueryResult } from "../persistence/sql_client.js";

const INSERT_CLAIM_SQL = `
  INSERT INTO processed_messages (wamid)
  VALUES ($1)
  ON CONFLICT (wamid) DO NOTHING
  RETURNING wamid
`;
const SELECT_CLAIM_SQL = `
  SELECT wamid
  FROM processed_messages
  WHERE wamid = $1
  LIMIT 1
`;
const RELEASE_CLAIM_SQL = `
  DELETE FROM processed_messages
  WHERE wamid = $1
`;

/** Run a parameterized query and validate the small result shape the adapter needs. */
async function query_count(
  sql_client: SqlClient,
  sql: string,
  values: readonly unknown[],
): Promise<number> {
  const result: SqlQueryResult = await sql_client.query(sql, values);
  if (!result) throw new Error("invalid-sql-result");
  if (Array.isArray(result.rows) && result.rows.length > 0) return result.rows.length;
  if (typeof result.rowCount === "number") return result.rowCount;
  if (Array.isArray(result.rows)) return 0;
  throw new Error("invalid-sql-result");
}

/** Treat a driver-reported unique conflict as a duplicate claim. */
function is_unique_violation(error: unknown): boolean {
  if (!(error instanceof DedupeStoreError)) return false;
  const cause = (error as Error & { cause?: unknown }).cause;
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { code?: unknown }).code === "23505"
  );
}

/** Postgres claim store backed by the unique `processed_messages.wamid` key. */
export class PostgresMessageDedupe implements MessageDedupeStore {
  private readonly sql_client: SqlClient | undefined;

  /**
   * Create a Postgres dedupe adapter.
   *
   * Args:
   *   sql_client: Minimal SQL client supplied by the runtime composition root.
   */
  constructor(sql_client?: SqlClient) {
    this.sql_client = sql_client;
  }

  /**
   * Check whether a message id has already been claimed.
   *
   * Args:
   *   wamid: Stable Meta message id.
   *
   * Returns:
   *   True when a persisted claim exists.
   *
   * Raises:
   *   InvalidWamidError: If the id is empty or too long.
   *   DedupeStoreError: If the SQL client is missing or the query fails.
   */
  async has_seen(wamid: string): Promise<boolean> {
    assert_valid_wamid(wamid);
    const row_count = await this.execute(SELECT_CLAIM_SQL, [wamid]);
    return row_count > 0;
  }

  /**
   * Atomically claim a message id exactly once.
   *
   * Args:
   *   wamid: Stable Meta message id.
   *
   * Returns:
   *   True when this caller inserted the claim, false for a duplicate.
   *
   * Raises:
   *   InvalidWamidError: If the id is empty or too long.
   *   DedupeStoreError: If the SQL client is missing or the query fails.
   */
  async try_claim(wamid: string): Promise<boolean> {
    assert_valid_wamid(wamid);
    try {
      const row_count = await this.execute(INSERT_CLAIM_SQL, [wamid]);
      return row_count > 0;
    } catch (error) {
      if (is_unique_violation(error)) return false;
      throw error;
    }
  }

  /**
   * Remove a claim after enqueue failure so Meta retries remain processable.
   *
   * Args:
   *   wamid: Stable Meta message id to release.
   *
   * Raises:
   *   InvalidWamidError: If the id is empty or too long.
   *   DedupeStoreError: If the SQL client is missing or the query fails.
   */
  async release_claim(wamid: string): Promise<void> {
    assert_valid_wamid(wamid);
    await this.execute_write(RELEASE_CLAIM_SQL, [wamid]);
  }

  private require_client(): SqlClient {
    if (this.sql_client === undefined) {
      throw new DedupeStoreError("postgres-dedupe-client-missing");
    }
    return this.sql_client;
  }

  private async execute(sql: string, values: readonly unknown[]): Promise<number> {
    try {
      return await query_count(this.require_client(), sql, values);
    } catch (error) {
      if (error instanceof DedupeStoreError) throw error;
      throw new DedupeStoreError("postgres-dedupe-query-failed", error);
    }
  }

  private async execute_write(sql: string, values: readonly unknown[]): Promise<void> {
    try {
      await this.require_client().query(sql, values);
    } catch (error) {
      if (error instanceof DedupeStoreError) throw error;
      throw new DedupeStoreError("postgres-dedupe-query-failed", error);
    }
  }
}
