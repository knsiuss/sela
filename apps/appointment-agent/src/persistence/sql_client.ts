/** Minimal SQL result and transaction shapes shared by adapters and test doubles. */

export interface SqlQueryResult {
  rows?: unknown[];
  rowCount?: number | null;
}

/** SQL surface available inside one transaction on a dedicated connection. */
export interface SqlTransactionClient {
  query(sql: string, values?: readonly unknown[]): Promise<SqlQueryResult>;
}

/** Work executed against one transaction-scoped SQL client. */
export type SqlTransactionWork<T> = (transaction: SqlTransactionClient) => Promise<T>;

/** Database boundary accepted by the Postgres adapters. */
export interface SqlClient {
  query(sql: string, values?: readonly unknown[]): Promise<SqlQueryResult>;
  /**
   * Run work on one dedicated transaction connection.
   *
   * Implementations must commit on success and roll back on failure. The
   * optional signal cancels the transaction and releases/destroys its dedicated
   * connection. The method is optional so small query-only test doubles remain
   * compatible with the existing read/write adapters.
   */
  with_transaction?<T>(work: SqlTransactionWork<T>, signal?: AbortSignal): Promise<T>;
  /** Release pooled resources when the composition owns the client. */
  close?(): Promise<void>;
}

/** A SQL client that guarantees a transaction-scoped connection is available. */
export interface TransactionalSqlClient extends SqlClient {
  with_transaction<T>(work: SqlTransactionWork<T>): Promise<T>;
}
