import type { SqlClient, SqlQueryResult } from "../persistence/sql_client.js";
import type { QueuedWebhookJob, WebhookJobQueue } from "../webhook_handler.js";

export type { SqlClient } from "../persistence/sql_client.js";

const INSERT_JOB_SQL = `
  INSERT INTO webhook_jobs (tenant_id, request_id, wamid, conversation_id, received_at_iso)
  VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT (wamid) DO NOTHING
  RETURNING id
`;
const MAX_ID_LENGTH = 128;

/** Raised when a job is invalid before it reaches the database boundary. */
export class InvalidWebhookJobError extends Error {
  constructor() {
    super("invalid-webhook-job");
    this.name = "InvalidWebhookJobError";
  }
}

/** Raised when the database cannot persist a webhook job. */
export class WebhookJobQueueError extends Error {
  constructor(cause?: unknown) {
    super("webhook-job-queue-failed", cause === undefined ? undefined : { cause });
    this.name = "WebhookJobQueueError";
  }
}

function is_non_empty_id(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= MAX_ID_LENGTH
  );
}

function assert_valid_job(job: QueuedWebhookJob): void {
  if (
    !job ||
    !is_non_empty_id(job.request_id) ||
    !is_non_empty_id(job.wamid) ||
    !is_non_empty_id(job.conversation_id) ||
    typeof job.received_at_iso !== "string" ||
    !Number.isFinite(Date.parse(job.received_at_iso)) ||
    !is_non_empty_id(job.tenant_id)
  ) {
    throw new InvalidWebhookJobError();
  }
}

function assert_query_result(result: SqlQueryResult): void {
  if (Array.isArray(result.rows) || typeof result.rowCount === "number") return;
  throw new WebhookJobQueueError();
}

/** Postgres queue adapter for the asynchronous webhook worker boundary. */
export class PostgresWebhookJobQueue implements WebhookJobQueue {
  private readonly sql_client: SqlClient | undefined;

  /**
   * Create a Postgres webhook queue adapter.
   *
   * Args:
   *   sql_client: Minimal SQL client supplied by the runtime composition root.
   */
  constructor(sql_client?: SqlClient) {
    this.sql_client = sql_client;
  }

  /**
   * Persist one PII-free job for a worker to claim later.
   *
   * The unique wamid conflict is treated as idempotent success so a retry
   * after an ambiguous database failure cannot create duplicate work.
   *
   * Args:
   *   job: Validated ids and receipt timestamp from ingress processing.
   *
   * Raises:
   *   InvalidWebhookJobError: If a job field is missing, too long, or not a date.
   *   WebhookJobQueueError: If the SQL client is missing or the insert fails.
   */
  async enqueue(job: QueuedWebhookJob): Promise<void> {
    assert_valid_job(job);
    const sql_client = this.sql_client;
    if (sql_client === undefined) {
      throw new WebhookJobQueueError();
    }
    try {
      const result = await sql_client.query(INSERT_JOB_SQL, [
        job.tenant_id,
        job.request_id,
        job.wamid,
        job.conversation_id,
        job.received_at_iso,
      ]);
      assert_query_result(result);
    } catch (error) {
      throw new WebhookJobQueueError(error);
    }
  }
}

export { PostgresWebhookJobQueue as PostgresOutboxQueue };
