import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { InMemoryMessageDedupe } from "../src/ingress/dedupe.js";
import {
  InMemoryWebhookQueue,
  WebhookQueueError,
  handle_inbound_request,
  type QueuedWebhookJob,
  type WebhookJobQueue,
} from "../src/webhook_handler.js";

const APP_SECRET = "handler-test-secret";
const RAW_BODY = JSON.stringify({
  object: "whatsapp_business_account",
  entry: [
    {
      changes: [
        {
          value: {
            messages: [
              {
                id: "wamid.handler-regression",
                from: "15551234567",
                type: "text",
                timestamp: "1780000000",
                text: { body: "hello" },
              },
            ],
          },
        },
      ],
    },
  ],
});

class FlakyWebhookQueue implements WebhookJobQueue {
  attempts = 0;
  jobs: QueuedWebhookJob[] = [];

  async enqueue(job: QueuedWebhookJob): Promise<void> {
    this.attempts += 1;
    if (this.attempts === 1) throw new Error("temporary queue failure");
    this.jobs.push(job);
  }
}

function sign(body: string): string {
  return `sha256=${createHmac("sha256", APP_SECRET).update(body).digest("hex")}`;
}

describe("handle_inbound_request", () => {
  it("releases a claim when enqueue fails so a retry can be processed", async () => {
    const store = new InMemoryMessageDedupe();
    const release_claim = vi.spyOn(store, "release_claim");
    const queue = new FlakyWebhookQueue();

    await expect(
      handle_inbound_request(RAW_BODY, sign(RAW_BODY), APP_SECRET, store, queue),
    ).rejects.toThrow(WebhookQueueError);
    expect(release_claim).toHaveBeenCalledWith("wamid.handler-regression");
    expect(await store.has_seen("wamid.handler-regression")).toBe(false);

    const result = await handle_inbound_request(
      RAW_BODY,
      sign(RAW_BODY),
      APP_SECRET,
      store,
      queue,
    );

    expect(result.enqueued_count).toBe(1);
    expect(queue.jobs).toHaveLength(1);
  });

  it("counts a repeated delivery as a duplicate without enqueueing twice", async () => {
    const store = new InMemoryMessageDedupe();
    const queue = new InMemoryWebhookQueue();

    const first = await handle_inbound_request(
      RAW_BODY,
      sign(RAW_BODY),
      APP_SECRET,
      store,
      queue,
    );
    const second = await handle_inbound_request(
      RAW_BODY,
      sign(RAW_BODY),
      APP_SECRET,
      store,
      queue,
    );

    expect(first.enqueued_count).toBe(1);
    expect(second).toMatchObject({ received_count: 1, duplicate_count: 1, enqueued_count: 0 });
    expect(queue.pending_jobs()).toHaveLength(1);
  });
});
