import { describe, expect, it, vi } from "vitest";
import { JobLifecycleError, PostgresJobLifecycleStore } from "../src/worker/job_store.js";
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
};

describe("job lifecycle store", () => {
  it("persists completion and bounded retry metadata with bound values", async () => {
    const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rowCount: 1 }));
    const store = new PostgresJobLifecycleStore({ query } satisfies SqlClient);
    const retry_at = new Date("2026-09-24T08:01:00.000Z");

    await store.complete(JOB);
    await store.fail(JOB, "graph_failed", retry_at);

    expect(query.mock.calls[0]?.[1]).toEqual(["job-lifecycle", "42"]);
    expect(query.mock.calls[1]?.[1]).toEqual(["job-lifecycle", retry_at.toISOString(), "graph_failed", "42"]);
  });

  it("rejects unsafe error codes and missing updates", async () => {
    const query = vi.fn(async () => ({ rowCount: 0 }));
    const store = new PostgresJobLifecycleStore({ query } satisfies SqlClient);

    await expect(store.fail(JOB, "raw error with spaces")).rejects.toBeInstanceOf(JobLifecycleError);
    await expect(store.complete(JOB)).rejects.toBeInstanceOf(JobLifecycleError);
  });
});
