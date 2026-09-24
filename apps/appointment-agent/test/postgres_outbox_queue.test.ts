import { describe, expect, it, vi } from "vitest";
import {
  InvalidWebhookJobError,
  PostgresWebhookJobQueue,
  WebhookJobQueueError,
  type SqlClient,
} from "../src/queue/postgres_outbox_queue.js";

const JOB = {
  request_id: "request-test",
  wamid: "wamid.queue-test",
  conversation_id: "conversation-test",
  received_at_iso: "2026-09-24T00:00:00.000Z",
  tenant_id: "42",
};

describe("postgres_webhook_job_queue", () => {
  it("inserts a PII-free job with bound parameters", async () => {
    const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows: [] }));
    const client: SqlClient = { query };
    const queue = new PostgresWebhookJobQueue(client);

    await queue.enqueue(JOB);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO webhook_jobs"),
      [JOB.tenant_id, JOB.request_id, JOB.wamid, JOB.conversation_id, JOB.received_at_iso],
    );
    expect(query.mock.calls[0]?.[0]).toContain("ON CONFLICT (wamid) DO NOTHING");
  });

  it("translates a database failure without exposing driver details", async () => {
    const query = vi.fn(async () => {
      throw new Error("connection string and internal query");
    });
    const queue = new PostgresWebhookJobQueue({ query } satisfies SqlClient);

    try {
      await queue.enqueue(JOB);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(WebhookJobQueueError);
      expect((error as Error).message).not.toContain("connection string and internal query");
    }
  });

  it("rejects an invalid job before querying the database", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const queue = new PostgresWebhookJobQueue({ query } satisfies SqlClient);

    await expect(queue.enqueue({ ...JOB, received_at_iso: "not-a-date" })).rejects.toBeInstanceOf(
      InvalidWebhookJobError,
    );
    expect(query).not.toHaveBeenCalled();
  });
});
