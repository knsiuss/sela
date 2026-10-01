import { describe, expect, it } from "vitest";
import { InMemoryMessageDedupe } from "../src/ingress/dedupe.js";
import { InMemoryTenantRateLimiter, RateLimiterUnavailableError, PostgresTenantRateLimiter } from "../src/rate_limit/tenant_rate_limiter.js";
import { run_worker_loop } from "../src/worker/loop.js";
import { JobProcessingError } from "../src/worker/process_job.js";
import type { ClaimedWebhookJob } from "../src/worker/job_claim.js";

function job(id: string): ClaimedWebhookJob {
  return {
    id,
    attempts: 1,
    tenant_id: "42",
    request_id: `request-${id}`,
    wamid: `wamid-${id}`,
    conversation_id: "conversation-1",
    received_at_iso: "2026-09-25T00:00:00.000Z",
  };
}

describe("bounded reliability and chaos smoke", () => {
  it("handles concurrent admission without cross-tenant interference", async () => {
    const limiter = new InMemoryTenantRateLimiter(() => 1_000);
    const results = await Promise.all([
      ...Array.from({ length: 100 }, () => limiter.consume({ tenant_id: "42", scope: "webhook", limit: 100, window_seconds: 60 })),
      ...Array.from({ length: 100 }, () => limiter.consume({ tenant_id: "43", scope: "webhook", limit: 100, window_seconds: 60 })),
    ]);
    expect(results.filter((result) => result.allowed)).toHaveLength(200);
    expect(results.every((result) => result.remaining >= 0)).toBe(true);
  });

  it("continues after bounded worker failures and stops on abort", async () => {
    const controller = new AbortController();
    let index = 0;
    const claimer = {
      claim_next_job: async (): Promise<ClaimedWebhookJob | null> => {
        if (index >= 5) {
          controller.abort();
          return null;
        }
        return job(String(index++));
      },
    };
    const counters = await run_worker_loop({
      claimer,
      tenant_id: "42",
      process: async (current): Promise<[]> => {
        if (current.id === "2") throw new JobProcessingError("provider_timeout");
        return [];
      },
      poll_interval_ms: 1,
      batch_size: 2,
      signal: controller.signal,
      wait: async () => undefined,
    });
    expect(counters).toEqual({ processed: 4, failed: 1, skipped: 0 });
  });

  it("fails closed when a durable rate-limit store is unavailable", async () => {
    const limiter = new PostgresTenantRateLimiter({
      query: async () => {
        throw new Error("pool exhausted");
      },
    });
    await expect(limiter.consume({ tenant_id: "42", scope: "webhook", limit: 10, window_seconds: 60 }))
      .rejects.toBeInstanceOf(RateLimiterUnavailableError);
  });

  it("admits exactly one concurrent ingress claim for the same message", async () => {
    const dedupe = new InMemoryMessageDedupe();
    const results = await Promise.all(
      Array.from({ length: 200 }, () => dedupe.try_claim("42", "wamid-storm-1")),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await dedupe.has_seen("42", "wamid-storm-1")).toBe(true);
  });

  it("drains a bounded worker load without loss or duplication", async () => {
    const controller = new AbortController();
    const pending = Array.from({ length: 200 }, (_, index) => job(`load-${index}`));
    const seen: string[] = [];
    const counters = await run_worker_loop({
      claimer: {
        claim_next_job: async () => {
          const next = pending.shift() ?? null;
          if (next === null) controller.abort();
          return next;
        },
      },
      tenant_id: "42",
      process: async (current) => {
        seen.push(current.id);
        return [];
      },
      poll_interval_ms: 1,
      batch_size: 10,
      signal: controller.signal,
      wait: async () => undefined,
    });
    expect(counters).toEqual({ processed: 200, failed: 0, skipped: 0 });
    expect(new Set(seen).size).toBe(200);
  });

  it("stays bounded under database latency and recovers after pool exhaustion", async () => {
    const window_row = { request_count: 1, limit_count: 10, window_seconds: 60, window_bucket: 29_000_000 };
    const slow = new PostgresTenantRateLimiter({
      query: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { rows: [window_row] };
      },
    });
    const decision = await slow.consume({ tenant_id: "42", scope: "webhook", limit: 10, window_seconds: 60 });
    expect(decision.allowed).toBe(true);

    let calls = 0;
    const flapping = new PostgresTenantRateLimiter({
      query: async () => {
        calls += 1;
        if (calls === 1) throw new Error("pool exhausted");
        return { rows: [window_row] };
      },
    });
    await expect(flapping.consume({ tenant_id: "42", scope: "webhook", limit: 10, window_seconds: 60 }))
      .rejects.toBeInstanceOf(RateLimiterUnavailableError);
    const recovered = await flapping.consume({ tenant_id: "42", scope: "webhook", limit: 10, window_seconds: 60 });
    expect(recovered.allowed).toBe(true);
  });

  it("recovers when a provider timeout succeeds on redelivery", async () => {
    const controller = new AbortController();
    let deliveries = 0;
    let attempts = 0;
    const counters = await run_worker_loop({
      claimer: {
        claim_next_job: async () => {
          if (deliveries >= 3) {
            controller.abort();
            return null;
          }
          deliveries += 1;
          return job("flaky-1");
        },
      },
      tenant_id: "42",
      process: async () => {
        attempts += 1;
        if (attempts < 3) throw new JobProcessingError("provider_timeout");
        return [];
      },
      poll_interval_ms: 1,
      batch_size: 1,
      signal: controller.signal,
      wait: async () => undefined,
    });
    expect(counters).toEqual({ processed: 1, failed: 2, skipped: 0 });
  });

  it("stops cleanly when killed before and during claim boundaries", async () => {
    const before = new AbortController();
    const killed_before = await run_worker_loop({
      claimer: {
        claim_next_job: async () => {
          before.abort();
          return null;
        },
      },
      tenant_id: "42",
      process: async () => [],
      poll_interval_ms: 1,
      batch_size: 5,
      signal: before.signal,
      wait: async () => undefined,
    });
    expect(killed_before).toEqual({ processed: 0, failed: 0, skipped: 0 });

    const during = new AbortController();
    const killed_during = await run_worker_loop({
      claimer: { claim_next_job: async () => job("kill-1") },
      tenant_id: "42",
      process: async () => {
        during.abort();
        return [];
      },
      poll_interval_ms: 1,
      batch_size: 5,
      signal: during.signal,
      wait: async () => undefined,
    });
    expect(killed_during.processed).toBe(1);
  });

  it("absorbs a retry storm without hanging or double counting", async () => {
    const controller = new AbortController();
    const pending = Array.from({ length: 50 }, (_, index) => job(`storm-${index}`));
    const counters = await run_worker_loop({
      claimer: {
        claim_next_job: async () => {
          const next = pending.shift() ?? null;
          if (next === null) controller.abort();
          return next;
        },
      },
      tenant_id: "42",
      process: async () => {
        throw new JobProcessingError("provider_timeout");
      },
      poll_interval_ms: 1,
      batch_size: 10,
      signal: controller.signal,
      wait: async () => undefined,
    });
    expect(counters).toEqual({ processed: 0, failed: 50, skipped: 0 });
  });

  it("redelivers unclaimed jobs after graceful shutdown", async () => {
    const controller = new AbortController();
    const pending = Array.from({ length: 5 }, (_, index) => job(`lease-${index}`));
    let processed = 0;
    const first = await run_worker_loop({
      claimer: {
        claim_next_job: async () => pending.shift() ?? null,
      },
      tenant_id: "42",
      process: async () => {
        processed += 1;
        if (processed === 2) controller.abort();
        return [];
      },
      poll_interval_ms: 1,
      batch_size: 1,
      signal: controller.signal,
      wait: async () => undefined,
    });
    expect(first.processed).toBe(2);

    const resume = new AbortController();
    const second = await run_worker_loop({
      claimer: {
        claim_next_job: async () => {
          const next = pending.shift() ?? null;
          if (next === null) resume.abort();
          return next;
        },
      },
      tenant_id: "42",
      process: async () => [],
      poll_interval_ms: 1,
      batch_size: 5,
      signal: resume.signal,
      wait: async () => undefined,
    });
    expect(second).toEqual({ processed: 3, failed: 0, skipped: 0 });
    expect(pending).toHaveLength(0);
  });
});
