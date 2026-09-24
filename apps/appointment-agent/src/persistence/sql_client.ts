/** Minimal SQL result shape shared by adapters and lightweight test doubles. */
export interface SqlQueryResult {
  rows?: unknown[];
  rowCount?: number | null;
}

/** Database boundary accepted by the Postgres adapters. */
export interface SqlClient {
  query(sql: string, values?: readonly unknown[]): Promise<SqlQueryResult>;
}
