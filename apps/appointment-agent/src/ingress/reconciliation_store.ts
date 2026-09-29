/** Bounded orphan scan over the claim/job/row join for reconciliation. */

import type { SqlClient, SqlQueryResult } from "../persistence/sql_client.js";
import type { IngressTriple, ReconciliationJobState } from "./reconciliation.js";
import { IngressReconciliationError, MAX_RECONCILIATION_BATCH_LIMIT } from "./reconciliation.js";

/** Narrow port for the bounded orphan scan boundary. */
export interface IngressOrphanScanner {
  /**
   * Scan one bounded batch of claim/job/row triples.
   *
   * @param limit - Maximum triples to return.
   * @param signal - Optional cancellation signal.
   * @returns Observed triples in oldest-first order.
   */
  scan_orphans(limit: number, signal?: AbortSignal): Promise<IngressTriple[]>;
}

const SCAN_ORPHANS_SQL = `
  SELECT pm.tenant_id::text AS tenant_id,
         pm.wamid AS wamid,
         true AS has_claim,
         (im.id IS NOT NULL) AS has_inbound_row,
         COALESCE(wj.status, 'missing') AS job_status,
         (im.processed_at IS NOT NULL) AS inbound_processed,
         pm.created_at AS observed_at
  FROM processed_messages AS pm
  LEFT JOIN inbound_messages AS im
    ON im.tenant_id = pm.tenant_id AND im.wamid = pm.wamid
  LEFT JOIN webhook_jobs AS wj
    ON wj.tenant_id = pm.tenant_id AND wj.wamid = pm.wamid
  WHERE wj.id IS NULL OR im.id IS NULL
  ORDER BY pm.created_at, pm.wamid
  LIMIT $1
`;

/** Parameterized Postgres scanner over the claim/job/row join. */
export class PostgresIngressOrphanScanner implements IngressOrphanScanner {
  private readonly sql_client: SqlClient;

  /**
   * Create a scanner over the server-side SQL boundary.
   *
   * @param sql_client - Server-side SQL boundary.
   */
  constructor(sql_client: SqlClient) {
    this.sql_client = sql_client;
  }

  /**
   * Scan one bounded orphan-candidate batch, oldest first.
   *
   * @param limit - Maximum triples, capped by the reconciliation hard cap.
   * @param signal - Optional cancellation signal.
   * @returns Normalized triples with tenant-scoped keys.
   */
  async scan_orphans(limit: number, signal?: AbortSignal): Promise<IngressTriple[]> {
    const bounded = normalize_scan_limit(limit);
    try {
      const result = await this.sql_client.query(SCAN_ORPHANS_SQL, [bounded], signal);
      return normalize_triples(result);
    } catch (error) {
      if (error instanceof IngressReconciliationError) throw error;
      throw new IngressReconciliationError("ingress-scan-failed", error);
    }
  }
}

/** In-memory scanner for unit tests and explicit local composition. */
export class InMemoryIngressOrphanScanner implements IngressOrphanScanner {
  private readonly triples: IngressTriple[];

  /**
   * Create a scanner over fixed triples.
   *
   * @param triples - Pre-observed triples returned in order.
   */
  constructor(triples: readonly IngressTriple[] = []) {
    this.triples = triples.map((triple) => ({ ...triple }));
  }

  /**
   * Return up to limit triples in insertion order.
   *
   * @param limit - Maximum triples to return.
   * @returns Defensive copies of the observed triples.
   */
  async scan_orphans(limit: number): Promise<IngressTriple[]> {
    const bounded = normalize_scan_limit(limit);
    return this.triples.slice(0, bounded).map((triple) => ({ ...triple }));
  }
}

function normalize_scan_limit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_RECONCILIATION_BATCH_LIMIT) {
    throw new IngressReconciliationError("ingress-batch-limit-invalid");
  }
  return limit;
}

function normalize_triples(result: SqlQueryResult): IngressTriple[] {
  if (!Array.isArray(result.rows)) throw new IngressReconciliationError("ingress-scan-result-invalid");
  return result.rows.map((row) => normalize_triple(row));
}

function normalize_triple(row: unknown): IngressTriple {
  if (typeof row !== "object" || row === null) {
    throw new IngressReconciliationError("ingress-scan-row-invalid");
  }
  const record = row as Record<string, unknown>;
  const job_status = record["job_status"];
  if (!is_job_state(job_status)) throw new IngressReconciliationError("ingress-scan-row-invalid");
  if (record["has_claim"] !== true && record["has_claim"] !== false) {
    throw new IngressReconciliationError("ingress-scan-row-invalid");
  }
  return {
    tenant_id: require_id(string_value(record["tenant_id"])),
    wamid: require_wamid(string_value(record["wamid"])),
    has_claim: record["has_claim"],
    has_inbound_row: boolean_value(record["has_inbound_row"]),
    job_status,
    inbound_processed: boolean_value(record["inbound_processed"]),
    observed_at: timestamp_value(record["observed_at"]),
  };
}

function is_job_state(value: unknown): value is ReconciliationJobState {
  return (
    value === "missing" ||
    value === "pending" ||
    value === "claimed" ||
    value === "completed" ||
    value === "failed"
  );
}

function require_id(value: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 256) {
    throw new IngressReconciliationError("ingress-tenant_id-invalid");
  }
  return value;
}

function require_wamid(value: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 128) {
    throw new IngressReconciliationError("ingress-wamid-invalid");
  }
  return value;
}

function string_value(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  throw new IngressReconciliationError("ingress-scan-row-invalid");
}

function boolean_value(value: unknown): boolean {
  if (value === true || value === false) return value;
  throw new IngressReconciliationError("ingress-scan-row-invalid");
}

function timestamp_value(value: unknown): string {
  const text = string_value(value);
  if (!Number.isFinite(Date.parse(text))) throw new IngressReconciliationError("ingress-scan-row-invalid");
  return text;
}
