import { describe, expect, it } from "vitest";
import { build_composition } from "../src/composition.js";
import { build_inbound_message_record } from "../src/ingress/inbound_store.js";
import type { OutboundDraft } from "../src/worker/process_job.js";

const PHONE = "+15551234567";
const PHONE_NUMBER_ID = "phone-e2e";

describe("tenant-aware worker end-to-end path", () => {
  it("processes a signed ingress row and hands the reply to the injected sender", async () => {
    const sent: OutboundDraft[] = [];
    let resolve_sent: (() => void) | undefined;
    const sent_promise = new Promise<void>((resolve) => {
      resolve_sent = resolve;
    });
    const composition = build_composition({
      env: {
        USE_IN_MEMORY: "true",
        WHATSAPP_PHONE_NUMBER_ID: PHONE_NUMBER_ID,
        TENANT_ID: "42",
        WORKER_POLL_INTERVAL_MS: "5",
        WORKER_BATCH_SIZE: "1",
      },
      sender: {
        send: async (draft) => {
          sent.push(draft);
          resolve_sent?.();
        },
      },
    });
    const record = build_inbound_message_record({
      tenant_id: "42",
      recipient_cipher: composition.recipient_cipher,
      conversation_id: "conversation-e2e",
      message: {
        wamid: "wamid.e2e",
        sender_phone_e164: PHONE,
        text_body: "operator",
        message_kind: "text",
        sent_at_iso: new Date().toISOString(),
      },
    });
    await composition.inbound_store.save(record);
    await composition.job_queue.enqueue({
      request_id: "request-e2e",
      wamid: record.wamid,
      conversation_id: record.conversation_id,
      received_at_iso: record.received_at,
      tenant_id: "42",
    });

    composition.start_worker();
    await Promise.race([
      sent_promise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("sender-timeout")), 2_000)),
    ]);
    await composition.stop();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: PHONE, text: expect.stringContaining("team") });
  });
});
