import { describe, expect, it, vi } from "vitest";
import { InMemoryJobLifecycleStore, JobLifecycleError, PostgresJobLifecycleStore } from "../src/worker/job_store.js";
import type { SqlClient } from "../src/persistence/sql_client.js";
import type { ClaimedWebhookJob } from "../src/worker/job_claim.js";

const JOB: ClaimedWebhookJob = {
  id: "job-lifecycle",
  tenant_id: "42",
  request_id: "request-lifecycle",
  wamid: "wamid-lifecycle",
  conversation_id: "conversation-lifecycle",
  received_at_iso: "2026-09-24T08:00:00.000Z",
  attempts: 1,
  claim_token: "claim-token-lifecycle",
};

describe("job lifecycle store", () => {
  it("persists completion and bounded retry metadata with bound values", async () => {
    const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rowCount: 1 }));
    const store = new PostgresJobLifecycleStore({ query } satisfies SqlClient);
    const retry_at = new Date("2026-09-24T08:01:00.000Z");

    await store.complete(JOB);
    await store.fail(JOB, "graph_failed", retry_at);

    expect(query.mock.calls[0]?.[1]).toEqual(["job-lifecycle", "42", "claim-token-lifecycle"]);
    expect(query.mock.calls[1]?.[1]).toEqual([
      "job-lifecycle",
      retry_at.toISOString(),
      "graph_failed",
      "42",
      "claim-token-lifecycle",
    ]);
    expect(query.mock.calls[0]?.[0]).toContain("claim_token = $3");
    expect(query.mock.calls[0]?.[0]).toContain("status = 'claimed'");
    expect(query.mock.calls[0]?.[0]).toContain("claim_token = NULL");
    expect(query.mock.calls[1]?.[0]).toContain("claim_token = $5");
    expect(query.mock.calls[1]?.[0]).toContain("status = 'claimed'");
  });

  it("rejects unsafe error codes and missing updates", async () => {
    const query = vi.fn(async () => ({ rowCount: 0 }));
    const store = new PostgresJobLifecycleStore({ query } satisfies SqlClient);

    await expect(store.fail(JOB, "raw error with spaces")).rejects.toBeInstanceOf(JobLifecycleError);
    await expect(store.complete(JOB)).rejects.toBeInstanceOf(JobLifecycleError);
  });

  it("rejects stale writers when the active claim no longer matches", async () => {
    const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rowCount: 0 }));
    const store = new PostgresJobLifecycleStore({ query } satisfies SqlClient);
    const stale_job = { ...JOB, claim_token: "claim-token-old" };

    await expect(store.complete(stale_job)).rejects.toBeInstanceOf(JobLifecycleError);
    await expect(store.fail(stale_job, "graph_failed")).rejects.toBeInstanceOf(JobLifecycleError);

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[0]).toContain("claim_token = $3");
    expect(query.mock.calls[1]?.[0]).toContain("claim_token = $5");
  });

  it("fails closed when a write result has no verifiable row metadata", async () => {
    for (const result of [{}, { rowCount: null }, { rows: [] }]) {
      const query = vi.fn(async () => result);
      const store = new PostgresJobLifecycleStore({ query } satisfies SqlClient);
      await expect(store.complete(JOB)).rejects.toBeInstanceOf(JobLifecycleError);
    }
  });

  it("keeps tokenless legacy jobs compatible in memory but fails closed in Postgres", async () => {
    const legacy_job: ClaimedWebhookJob = { ...JOB };
    delete legacy_job.claim_token;
    const query = vi.fn();
    const store = new PostgresJobLifecycleStore({ query } satisfies SqlClient);

    await expect(store.complete(legacy_job)).rejects.toBeInstanceOf(JobLifecycleError);
    await expect(store.fail(legacy_job, "graph_failed")).rejects.toBeInstanceOf(JobLifecycleError);
    expect(query).not.toHaveBeenCalled();

    const in_memory_store = new InMemoryJobLifecycleStore();
    await expect(in_memory_store.complete(legacy_job)).resolves.toBeUndefined();
  });
});
