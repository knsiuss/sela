import type { SqlClient, SqlQueryResult } from "../persistence/sql_client.js";
import {
  DedupeStoreError,
  assert_valid_tenant_id,
  assert_valid_wamid,
} from "./dedupe_contract.js";
import type { MessageDedupeStore } from "./dedupe.js";

export type { SqlClient, SqlQueryResult } from "../persistence/sql_client.js";

// Keep tenant predicates explicit even for service_role: it bypasses RLS, while
// the client roles are denied access to this server-only table by the schema.
const INSERT_CLAIM_SQL = `
  INSERT INTO processed_messages (tenant_id, wamid)
  VALUES ($1, $2)
  ON CONFLICT (tenant_id, wamid) DO NOTHING
  RETURNING tenant_id, wamid
`;
const SELECT_CLAIM_SQL = `
  SELECT tenant_id, wamid
  FROM processed_messages
  WHERE tenant_id = $1 AND wamid = $2
  LIMIT 1
`;
const RELEASE_CLAIM_SQL = `
  DELETE FROM processed_messages
  WHERE tenant_id = $1 AND wamid = $2
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

/** Postgres claim store backed by the tenant-scoped processed-message key from migration 0011. */
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
   * Check whether a message id has already been claimed for a tenant.
   *
   * @param tenant_id - Owning tenant.
   * @param wamid - Stable Meta message id.
   * @returns True when a persisted tenant-scoped claim exists.
   * @throws InvalidTenantIdError or InvalidWamidError for invalid input.
   * @throws DedupeStoreError when the SQL client is missing or the query fails.
   */
  async has_seen(tenant_id: string, wamid: string): Promise<boolean> {
    assert_dedupe_identity(tenant_id, wamid);
    const row_count = await this.execute(SELECT_CLAIM_SQL, [tenant_id, wamid]);
    return row_count > 0;
  }

  /**
   * Atomically claim a tenant/message pair exactly once.
   *
   * @param tenant_id - Owning tenant.
   * @param wamid - Stable Meta message id.
   * @returns True when this caller inserted the claim, false for a duplicate.
   * @throws InvalidTenantIdError or InvalidWamidError for invalid input.
   * @throws DedupeStoreError when the SQL client is missing or the query fails.
   */
  async try_claim(tenant_id: string, wamid: string): Promise<boolean> {
    assert_dedupe_identity(tenant_id, wamid);
    // Intended duplicates are handled by ON CONFLICT and return rowCount 0.
    // Any driver-reported unique violation therefore indicates schema drift or
    // another constraint and must not be silently treated as a duplicate.
    const row_count = await this.execute(INSERT_CLAIM_SQL, [tenant_id, wamid]);
    return row_count > 0;
  }

  /**
   * Remove a tenant/message claim after enqueue failure so retries remain processable.
   *
   * @param tenant_id - Owning tenant.
   * @param wamid - Stable Meta message id to release.
   * @returns Nothing.
   * @throws InvalidTenantIdError or InvalidWamidError for invalid input.
   * @throws DedupeStoreError when the SQL client is missing or the query fails.
   */
  async release_claim(tenant_id: string, wamid: string): Promise<void> {
    assert_dedupe_identity(tenant_id, wamid);
    await this.execute_write(RELEASE_CLAIM_SQL, [tenant_id, wamid]);
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
      const result = await this.require_client().query(sql, values);
      if (!Array.isArray(result.rows) && typeof result.rowCount !== "number") {
        throw new Error("invalid-sql-result");
      }
    } catch (error) {
      if (error instanceof DedupeStoreError) throw error;
      throw new DedupeStoreError("postgres-dedupe-query-failed", error);
    }
  }
}

function assert_dedupe_identity(tenant_id: string, wamid: string): void {
  assert_valid_tenant_id(tenant_id);
  assert_valid_wamid(wamid);
}
