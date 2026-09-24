/** Lifecycle persistence for claimed webhook jobs. */

import type { SqlClient, SqlQueryResult } from "../persistence/sql_client.js";
import type { ClaimedWebhookJob } from "./job_claim.js";

/** Safe failure at the job lifecycle boundary. */
export class JobLifecycleError extends Error {
  /** Create a safe lifecycle error. */
  constructor(reason = "job-lifecycle-failed", cause?: unknown) {
    super(reason, cause === undefined ? undefined : { cause });
    this.name = "JobLifecycleError";
  }
}

/** Port used by the processor to complete or retry a claimed job. */
export interface JobLifecycleStore {
  /**
   * Mark a job completed.
   *
   * @param job - Claimed job identity.
   * @returns Nothing.
   */
  complete(job: ClaimedWebhookJob): Promise<void>;

  /**
   * Mark a job failed or return it to pending for a bounded retry.
   *
   * @param job - Claimed job identity.
   * @param error_code - Sanitized code only.
   * @param retry_at - Future availability instant, or undefined for terminal failure.
   * @returns Nothing.
   */
  fail(job: ClaimedWebhookJob, error_code: string, retry_at?: Date): Promise<void>;
}

const COMPLETE_JOB_SQL = `
  UPDATE webhook_jobs
  SET status = 'completed',
      last_error = NULL,
      claimed_at = NULL,
      claim_token = NULL
  WHERE id = $1
    AND tenant_id::text = $2
    AND claim_token = $3
    AND status = 'claimed'
`;

const FAIL_JOB_SQL = `
  UPDATE webhook_jobs
  SET status = CASE WHEN $2::timestamptz IS NULL THEN 'failed' ELSE 'pending' END,
      available_at = COALESCE($2::timestamptz, available_at),
      last_error = $3,
      claimed_at = NULL,
      claim_token = NULL
  WHERE id = $1
    AND tenant_id::text = $4
    AND claim_token = $5
    AND status = 'claimed'
`;

/** Parameterized Postgres lifecycle adapter. */
export class PostgresJobLifecycleStore implements JobLifecycleStore {
  private readonly sql_client: SqlClient;

  /**
   * Create a lifecycle store.
   *
   * @param sql_client - Server-side SQL boundary.
   */
  constructor(sql_client: SqlClient) {
    this.sql_client = sql_client;
  }

  /**
   * Mark a claimed job completed.
   *
   * @param job - Claimed job identity.
   * @returns Nothing.
   */
  async complete(job: ClaimedWebhookJob): Promise<void> {
    const claim_token = require_claim_token(job.claim_token);
    try {
      const result = await this.sql_client.query(COMPLETE_JOB_SQL, [job.id, job.tenant_id, claim_token]);
      ensure_write(result, "job-complete-update-failed");
    } catch (error) {
      throw new JobLifecycleError("job-complete-failed", error);
    }
  }

  /**
   * Persist a sanitized failure and optional retry deadline.
   *
   * @param job - Claimed job identity.
   * @param error_code - Stable code, never raw driver or message text.
   * @param retry_at - Retry deadline; undefined makes the failure terminal.
   * @returns Nothing.
   */
  async fail(job: ClaimedWebhookJob, error_code: string, retry_at?: Date): Promise<void> {
    if (!/^[a-z0-9_]{1,64}$/.test(error_code)) throw new JobLifecycleError("job-error-code-invalid");
    const claim_token = require_claim_token(job.claim_token);
    try {
      const result = await this.sql_client.query(FAIL_JOB_SQL, [
        job.id,
        retry_at?.toISOString() ?? null,
        error_code,
        job.tenant_id,
        claim_token,
      ]);
      ensure_write(result, "job-fail-update-failed");
    } catch (error) {
      throw new JobLifecycleError("job-fail-update-failed", error);
    }
  }
}

/** Require a token before attempting a fenced database write. */
function require_claim_token(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 256) {
    throw new JobLifecycleError("job-claim-token-required");
  }
  return value;
}

/** Reject an update that did not match the active claim. */
function ensure_write(result: SqlQueryResult, reason: string): void {
  if (typeof result.rowCount === "number") {
    if (result.rowCount < 1) throw new JobLifecycleError(reason);
    return;
  }
  if (Array.isArray(result.rows)) {
    if (result.rows.length < 1) throw new JobLifecycleError(reason);
    return;
  }
  throw new JobLifecycleError(reason);
}

/** In-memory lifecycle adapter for unit tests and explicit local mode. */
export class InMemoryJobLifecycleStore implements JobLifecycleStore {
  private readonly states = new Map<string, { status: "pending" | "completed" | "failed"; error_code?: string; retry_at?: string }>();

  /**
   * Mark a job completed.
   *
   * @param job - Claimed job identity.
   * @returns Nothing.
   */
  async complete(job: ClaimedWebhookJob): Promise<void> {
    this.states.set(job.id, { status: "completed" });
  }

  /**
   * Record a terminal or retryable failure.
   *
   * @param job - Claimed job identity.
   * @param error_code - Sanitized error code.
   * @param retry_at - Optional retry deadline.
   * @returns Nothing.
   */
  async fail(job: ClaimedWebhookJob, error_code: string, retry_at?: Date): Promise<void> {
    if (!/^[a-z0-9_]{1,64}$/.test(error_code)) throw new JobLifecycleError("job-error-code-invalid");
    this.states.set(job.id, {
      status: retry_at === undefined ? "failed" : "pending",
      error_code,
      retry_at: retry_at?.toISOString(),
    });
  }

  /**
   * Read a lifecycle state for assertions.
   *
   * @param job_id - Claimed job id.
   * @returns Current state or undefined.
   */
  get(job_id: string): { status: string; error_code?: string; retry_at?: string } | undefined {
    const state = this.states.get(job_id);
    return state === undefined ? undefined : { ...state };
  }
}
