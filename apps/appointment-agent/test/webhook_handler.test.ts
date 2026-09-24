import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AtomicIngressStore } from "../src/ingress/postgres_atomic_ingress.js";
import { InMemoryMessageDedupe } from "../src/ingress/dedupe.js";
import { InMemoryInboundMessageStore } from "../src/ingress/inbound_store.js";
import { InMemoryTenantResolver } from "../src/ingress/tenant_resolver.js";
import { AesGcmRecipientCipher, RecipientCipherError } from "../src/security/recipient_cipher.js";
import {
  InMemoryWebhookQueue,
  WebhookQueueError,
  handle_inbound_request,
  type QueuedWebhookJob,
  type WebhookJobQueue,
} from "../src/webhook_handler.js";

const APP_SECRET = "handler-test-secret";
const RECIPIENT_CIPHER = new AesGcmRecipientCipher(Buffer.alloc(32, 5));
const RAW_BODY = JSON.stringify({
  object: "whatsapp_business_account",
  entry: [
    {
      changes: [
        {
          value: {
            phone_number_id: "phone-handler-test",
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

function ingress_options() {
  return { tenant_resolver: new InMemoryTenantResolver({ "phone-handler-test": "42" }) };
}

describe("handle_inbound_request", () => {
  it("fails closed when no tenant resolver is configured", async () => {
    const store = new InMemoryMessageDedupe();
    const queue = new InMemoryWebhookQueue();

    const result = await handle_inbound_request(
      RAW_BODY,
      sign(RAW_BODY),
      APP_SECRET,
      store,
      queue,
    );

    expect(result).toMatchObject({ enqueued_count: 0, unresolved_count: 1 });
    expect(queue.pending_jobs()).toHaveLength(0);
  });

  it("uses the atomic ingress path without legacy dedupe or queue calls", async () => {
    const dedupe_store = {
      has_seen: vi.fn(),
      try_claim: vi.fn(),
      release_claim: vi.fn(),
    };
    const queue = { enqueue: vi.fn() };
    const atomic_ingress: AtomicIngressStore = {
      accept: vi.fn(async ({ tenant_id, inbound_record }) => ({
        status: "accepted" as const,
        tenant_id,
        wamid: inbound_record.wamid,
      })),
    };

    const result = await handle_inbound_request(
      RAW_BODY,
      sign(RAW_BODY),
      APP_SECRET,
      dedupe_store,
      queue,
      { ...ingress_options(), recipient_cipher: RECIPIENT_CIPHER, atomic_ingress },
    );

    expect(result.enqueued_count).toBe(1);
    expect(atomic_ingress.accept).toHaveBeenCalledTimes(1);
    expect(dedupe_store.try_claim).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
    const atomic_input = vi.mocked(atomic_ingress.accept).mock.calls[0]?.[0];
    expect(atomic_input?.inbound_record).toMatchObject({
      tenant_id: "42",
      wamid: "wamid.handler-regression",
      reply_target_ciphertext: expect.stringMatching(/^v1\./),
    });
  });

  it("encrypts the reply target before retention and keeps it out of jobs and audit logs", async () => {
    const dedupe_store = new InMemoryMessageDedupe();
    const inbound_store = new InMemoryInboundMessageStore();
    const queue = new InMemoryWebhookQueue();
    const audit_spy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    try {
      const result = await handle_inbound_request(
        RAW_BODY,
        sign(RAW_BODY),
        APP_SECRET,
        dedupe_store,
        queue,
        {
          ...ingress_options(),
          inbound_store,
          recipient_cipher: RECIPIENT_CIPHER,
        },
      );
      const row = inbound_store.all()[0];
      const ciphertext = row?.reply_target_ciphertext;

      expect(result.enqueued_count).toBe(1);
      expect(ciphertext).toMatch(/^v1\./);
      expect(RECIPIENT_CIPHER.decrypt(ciphertext!)).toBe("+15551234567");
      expect(JSON.stringify(row)).not.toContain("+15551234567");
      expect(JSON.stringify(queue.pending_jobs())).not.toContain("+15551234567");
      expect(JSON.stringify(queue.pending_jobs())).not.toContain(ciphertext!);
      const audit_output = audit_spy.mock.calls.map((args) => JSON.stringify(args)).join("\n");
      expect(audit_output).not.toContain("+15551234567");
      expect(audit_output).not.toContain(ciphertext!);
    } finally {
      audit_spy.mockRestore();
    }
  });

  it("uses webhook receipt time for retention while preserving the provider timestamp", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-24T12:00:00.000Z"));
    const dedupe_store = new InMemoryMessageDedupe();
    const inbound_store = new InMemoryInboundMessageStore();
    const queue = new InMemoryWebhookQueue();

    try {
      const result = await handle_inbound_request(
        RAW_BODY,
        sign(RAW_BODY),
        APP_SECRET,
        dedupe_store,
        queue,
        {
          ...ingress_options(),
          inbound_store,
          recipient_cipher: RECIPIENT_CIPHER,
          retention_days: 7,
        },
      );
      const row = inbound_store.all()[0];
      const job = queue.pending_jobs()[0];

      expect(result.enqueued_count).toBe(1);
      expect(row).toMatchObject({
        received_at: "2026-05-28T20:26:40.000Z",
        expires_at: "2026-10-01T12:00:00.000Z",
      });
      expect(job?.received_at_iso).toBe("2026-09-24T12:00:00.000Z");
      expect(JSON.stringify(row)).not.toContain("+15551234567");
      expect(JSON.stringify(job)).not.toContain("+15551234567");
      expect(JSON.stringify(job)).not.toContain(row?.reply_target_ciphertext);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails before claiming when inbound persistence has no recipient cipher", async () => {
    const dedupe_store = new InMemoryMessageDedupe();
    const inbound_store = new InMemoryInboundMessageStore();
    const queue = new InMemoryWebhookQueue();

    await expect(
      handle_inbound_request(
        RAW_BODY,
        sign(RAW_BODY),
        APP_SECRET,
        dedupe_store,
        queue,
        { ...ingress_options(), inbound_store },
      ),
    ).rejects.toBeInstanceOf(RecipientCipherError);
    expect(await dedupe_store.has_seen("42", "wamid.handler-regression")).toBe(false);
    expect(queue.pending_jobs()).toHaveLength(0);
    expect(inbound_store.all()).toHaveLength(0);
  });

  it("releases a claim when enqueue fails so a retry can be processed", async () => {
    const store = new InMemoryMessageDedupe();
    const release_claim = vi.spyOn(store, "release_claim");
    const queue = new FlakyWebhookQueue();

    await expect(
      handle_inbound_request(RAW_BODY, sign(RAW_BODY), APP_SECRET, store, queue, ingress_options()),
    ).rejects.toThrow(WebhookQueueError);
    expect(release_claim).toHaveBeenCalledWith("42", "wamid.handler-regression");
    expect(await store.has_seen("42", "wamid.handler-regression")).toBe(false);

    const result = await handle_inbound_request(
      RAW_BODY,
      sign(RAW_BODY),
      APP_SECRET,
      store,
      queue,
      ingress_options(),
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
      ingress_options(),
    );
    const second = await handle_inbound_request(
      RAW_BODY,
      sign(RAW_BODY),
      APP_SECRET,
      store,
      queue,
      ingress_options(),
    );

    expect(first.enqueued_count).toBe(1);
    expect(second).toMatchObject({ received_count: 1, duplicate_count: 1, enqueued_count: 0 });
    expect(queue.pending_jobs()).toHaveLength(1);
  });
});
