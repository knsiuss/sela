/** Atomic worker claims for tenant-scoped webhook jobs. */

import type { SqlClient, SqlQueryResult } from "../persistence/sql_client.js";
import type { QueuedWebhookJob } from "../webhook_handler.js";

/** A claimed job plus the values needed by the processor. */
export interface ClaimedWebhookJob extends QueuedWebhookJob {
  id: string;
  attempts: number;
}

/** Read port consumed by the worker loop. */
export interface JobClaimer {
  /**
   * Claim one pending job.
   *
   * @param tenant_id - Optional tenant filter.
   * @returns The claimed job or null when the queue is empty.
   */
  claim_next_job(tenant_id?: string): Promise<ClaimedWebhookJob | null>;
}

/** Safe failure at the job claim boundary. */
export class JobClaimError extends Error {
  /** Create a safe claim error. */
  constructor(reason = "job-claim-failed", cause?: unknown) {
    super(reason, cause === undefined ? undefined : { cause });
    this.name = "JobClaimError";
  }
}

const CLAIM_ALL_SQL = `
  WITH next_job AS (
    SELECT id
    FROM webhook_jobs
    WHERE status = 'pending'
      AND tenant_id IS NOT NULL
      AND available_at <= now()
    ORDER BY created_at, id
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  UPDATE webhook_jobs AS job
  SET status = 'claimed',
      claimed_at = now(),
      attempts = attempts + 1
  FROM next_job
  WHERE job.id = next_job.id
  RETURNING job.id, job.tenant_id, job.request_id, job.wamid,
            job.conversation_id, job.received_at_iso, job.attempts
`;

const CLAIM_TENANT_SQL = `
  WITH next_job AS (
    SELECT id
    FROM webhook_jobs
    WHERE status = 'pending'
      AND available_at <= now()
      AND tenant_id = $1
    ORDER BY created_at, id
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  UPDATE webhook_jobs AS job
  SET status = 'claimed',
      claimed_at = now(),
      attempts = attempts + 1
  FROM next_job
  WHERE job.id = next_job.id
  RETURNING job.id, job.tenant_id, job.request_id, job.wamid,
            job.conversation_id, job.received_at_iso, job.attempts
`;

/** Claim one job through a parameterized Postgres statement. */
export async function claim_next_job(
  sql_client: SqlClient,
  tenant_id?: string,
): Promise<ClaimedWebhookJob | null> {
  return new PostgresJobClaimer(sql_client).claim_next_job(tenant_id);
}

/** Postgres implementation of the worker claim port. */
export class PostgresJobClaimer implements JobClaimer {
  private readonly sql_client: SqlClient;

  /**
   * Create a Postgres claimer.
   *
   * @param sql_client - Server-side SQL boundary.
   */
  constructor(sql_client: SqlClient) {
    this.sql_client = sql_client;
  }

  /**
   * Atomically claim the oldest available pending job.
   *
   * @param tenant_id - Optional tenant filter.
   * @returns A normalized claimed job or null.
   * @throws JobClaimError when the query or returned row is invalid.
   */
  async claim_next_job(tenant_id?: string): Promise<ClaimedWebhookJob | null> {
    try {
      const result =
        tenant_id === undefined
          ? await this.sql_client.query(CLAIM_ALL_SQL)
          : await this.sql_client.query(CLAIM_TENANT_SQL, [tenant_id]);
      return normalize_claim(result);
    } catch (error) {
      if (error instanceof JobClaimError) throw error;
      throw new JobClaimError("job-claim-query-failed", error);
    }
  }
}

function normalize_claim(result: SqlQueryResult): ClaimedWebhookJob | null {
  if (!Array.isArray(result.rows) || result.rows.length === 0) return null;
  const row = result.rows[0];
  if (typeof row !== "object" || row === null) throw new JobClaimError("job-claim-row-invalid");
  const record = row as Record<string, unknown>;
  const id = required_id(record["id"], "job_id");
  const attempts = Number(record["attempts"]);
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw new JobClaimError("job-claim-row-invalid");
  const tenant_value = record["tenant_id"];
  const tenant_id =
    tenant_value === undefined || tenant_value === null
      ? undefined
      : required_id(tenant_value, "tenant_id");
  return {
    id,
    attempts,
    tenant_id,
    request_id: required_id(record["request_id"], "request_id"),
    wamid: required_id(record["wamid"], "wamid"),
    conversation_id: required_id(record["conversation_id"], "conversation_id"),
    received_at_iso: required_timestamp(record["received_at_iso"], "received_at_iso"),
  };
}

function required_id(value: unknown, field_name: string): string {
  if (
    (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") ||
    String(value).trim() === "" ||
    String(value).length > 256
  ) {
    throw new JobClaimError(`job-claim-${field_name}-invalid`);
  }
  return String(value);
}

function required_timestamp(value: unknown, field_name: string): string {
  const text = required_id(value, field_name);
  const timestamp_ms = Date.parse(text);
  if (!Number.isFinite(timestamp_ms)) throw new JobClaimError(`job-claim-${field_name}-invalid`);
  return new Date(timestamp_ms).toISOString();
}
