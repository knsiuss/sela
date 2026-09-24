/** Abortable, non-busy polling loop for webhook jobs. */

import type { JobClaimer, ClaimedWebhookJob } from "./job_claim.js";
import { JobProcessingError, type OutboundDraft } from "./process_job.js";

/** Sender port kept local so this worker does not depend on an outbound package. */
export interface OutboundSenderPort {
  /**
   * Send one locally built draft through a per-sender adapter.
   *
   * @param draft - Tenant-safe outbound draft.
   * @returns Sender-specific acknowledgement.
   */
  send(draft: OutboundDraft): Promise<unknown>;
}

/** Tenant-aware port used by the worker to select a sender before provider I/O. */
export interface OutboundSenderRegistry {
  /**
   * Send one draft through the sender bound to the supplied tenant.
   *
   * @param tenant_id - Tenant carried by the claimed job.
   * @param draft - Tenant-safe outbound draft.
   * @returns Sender-specific acknowledgement.
   * @throws A sanitized registry error when the tenant has no configured sender.
   */
  send(tenant_id: string, draft: OutboundDraft): Promise<unknown>;
}

/** Counters returned when a worker loop stops. */
export interface WorkerLoopCounters {
  processed: number;
  failed: number;
  skipped: number;
}

/** Injectable loop dependencies and bounded polling policy. */
export interface WorkerLoopOptions {
  claimer: JobClaimer;
  /** Optional tenant admission scope; single-tenant workers must set this. */
  tenant_id?: string;
  process: (job: ClaimedWebhookJob) => Promise<OutboundDraft[]>;
  poll_interval_ms: number;
  batch_size: number;
  signal: AbortSignal;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  on_error?: (error: unknown, job?: ClaimedWebhookJob) => void;
}

/**
 * Poll and process jobs until the supplied signal is aborted.
 *
 * A failed claim or processor is counted and the loop continues after the
 * bounded timer. Delivery is owned by the processor so completion cannot race
 * a later send. There is no tight loop when the queue is empty.
 *
 * @param options - Claim/process ports and polling limits.
 * @returns Aggregate counters after graceful stop.
 */
export async function run_worker_loop(options: WorkerLoopOptions): Promise<WorkerLoopCounters> {
  const poll_interval_ms = positive_integer(options.poll_interval_ms, "poll_interval_ms");
  const batch_size = positive_integer(options.batch_size, "batch_size");
  const wait = options.wait ?? wait_for_timer;
  const counters: WorkerLoopCounters = { processed: 0, failed: 0, skipped: 0 };

  while (!options.signal.aborted) {
    let claimed_in_batch = 0;
    while (claimed_in_batch < batch_size && !options.signal.aborted) {
      let job: ClaimedWebhookJob | null;
      try {
        job = await options.claimer.claim_next_job(options.tenant_id);
      } catch (error) {
        counters.failed += 1;
        report_error(options, error);
        break;
      }
      if (job === null) break;
      claimed_in_batch += 1;
      try {
        await options.process(job);
        counters.processed += 1;
      } catch (error) {
        if (error instanceof JobProcessingError && error.is_skipped) counters.skipped += 1;
        else counters.failed += 1;
        report_error(options, error, job);
      }
    }
    if (options.signal.aborted) break;
    await wait(poll_interval_ms, options.signal);
  }
  return counters;
}

/** Descriptive alias for callers that prefer an imperative start name. */
export const start_worker_loop = run_worker_loop;

function wait_for_timer(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", on_abort);
      resolve();
    }, milliseconds);
    const on_abort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", on_abort);
      resolve();
    };
    signal.addEventListener("abort", on_abort, { once: true });
  });
}

function report_error(
  options: WorkerLoopOptions,
  error: unknown,
  job?: ClaimedWebhookJob,
): void {
  if (options.on_error !== undefined) {
    options.on_error(error, job);
    return;
  }
  console.error(
    JSON.stringify({
      event: "worker_job_error",
      job_id: job?.id,
      tenant_id: job?.tenant_id,
      error_name: error instanceof Error ? error.name : "UnknownError",
      ...(error instanceof JobProcessingError ? { error_code: error.code } : {}),
    }),
  );
}

function positive_integer(value: number, field_name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field_name} must be a positive integer`);
  }
  return value;
}
