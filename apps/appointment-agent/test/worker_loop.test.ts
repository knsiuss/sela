import { describe, expect, it, vi } from "vitest";
import { run_worker_loop } from "../src/worker/loop.js";
import type { OutboundDraft } from "../src/worker/process_job.js";
import { JobProcessingError } from "../src/worker/process_job.js";
import type { ClaimedWebhookJob, JobClaimer } from "../src/worker/job_claim.js";

function job(id: string): ClaimedWebhookJob {
  return {
    id,
    tenant_id: "42",
    request_id: `request-${id}`,
    wamid: `wamid-${id}`,
    conversation_id: "conversation-42",
    received_at_iso: "2026-09-24T08:00:00.000Z",
    attempts: 1,
  };
}

describe("worker loop", () => {
  it("continues after one job error, processes later jobs, and stops on abort", async () => {
    const controller = new AbortController();
    const first = job("first");
    const second = job("second");
    const queued = [first, second, null];
    const claimer: JobClaimer = {
      claim_next_job: vi.fn(async () => queued.shift() ?? null),
    };
    const process = vi.fn(async (claimed: ClaimedWebhookJob): Promise<OutboundDraft[]> => {
      if (claimed.id === "first") throw new Error("one job failed");
      return [{ to: "+12025550123", message_type: "text", text: "done" }];
    });
    const wait = vi.fn(async () => controller.abort());

    const counters = await run_worker_loop({
      claimer,
      tenant_id: "42",
      process,
      poll_interval_ms: 1,
      batch_size: 10,
      signal: controller.signal,
      wait,
    });

    expect(counters).toEqual({ processed: 1, failed: 1, skipped: 0 });
    expect(process).toHaveBeenCalledTimes(2);
    expect(claimer.claim_next_job).toHaveBeenCalledWith("42");
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it("counts an explicitly skipped job separately", async () => {
    const controller = new AbortController();
    const queued: Array<ClaimedWebhookJob | null> = [job("skip"), null];
    const claimer: JobClaimer = { claim_next_job: vi.fn(async () => queued.shift() ?? null) };
    const wait = vi.fn(async () => controller.abort());

    const counters = await run_worker_loop({
      claimer,
      process: vi.fn(async () => {
        throw new JobProcessingError("missing_inbound_message", true);
      }),
      poll_interval_ms: 1,
      batch_size: 1,
      signal: controller.signal,
      wait,
    });

    expect(counters).toEqual({ processed: 0, failed: 0, skipped: 1 });
  });
});
