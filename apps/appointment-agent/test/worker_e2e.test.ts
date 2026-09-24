import { describe, expect, it } from "vitest";
import { build_composition } from "../src/composition.js";
import { build_inbound_message_record } from "../src/ingress/inbound_store.js";
import type { OutboundDraft } from "../src/worker/process_job.js";

const PHONE = "+15551234567";
const PHONE_NUMBER_ID = "phone-e2e";

async function wait_for_sent_count(sent: readonly OutboundDraft[], expected_count: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (sent.length < expected_count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (sent.length < expected_count) throw new Error("sender-timeout");
}

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

  it("keeps one local calendar and session across three separate worker jobs", async () => {
    const sent: OutboundDraft[] = [];
    const slot_start_ms = Date.now() + 24 * 60 * 60 * 1000;
    const composition = build_composition({
      env: {
        USE_IN_MEMORY: "true",
        WHATSAPP_PHONE_NUMBER_ID: PHONE_NUMBER_ID,
        TENANT_ID: "42",
        WORKER_POLL_INTERVAL_MS: "5",
        WORKER_BATCH_SIZE: "1",
      },
      slots: [
        {
          id: "slot-e2e",
          start_iso: new Date(slot_start_ms).toISOString(),
          end_iso: new Date(slot_start_ms + 30 * 60 * 1000).toISOString(),
        },
      ],
      sender: { send: async (draft) => sent.push(draft) },
    });
    const messages = [
      { wamid: "wamid.e2e.offer", text_body: "I want to reschedule", message_kind: "text" as const },
      {
        wamid: "wamid.e2e.pick",
        text_body: "Pick slot 1",
        message_kind: "button_reply" as const,
        button_id: "pick_slot_1_g1",
      },
      {
        wamid: "wamid.e2e.confirm",
        text_body: "Confirm move",
        message_kind: "button_reply" as const,
        button_id: "confirm_move_g1",
      },
    ];

    try {
      for (const [index, message] of messages.entries()) {
        const record = build_inbound_message_record({
          tenant_id: "42",
          recipient_cipher: composition.recipient_cipher,
          conversation_id: "conversation-e2e-multiturn",
          message: {
            ...message,
            sender_phone_e164: PHONE,
            sent_at_iso: new Date().toISOString(),
          },
        });
        await composition.inbound_store.save(record);
        await composition.job_queue.enqueue({
          request_id: `request-e2e-${index}`,
          wamid: record.wamid,
          conversation_id: record.conversation_id,
          received_at_iso: record.received_at,
          tenant_id: "42",
        });
      }

      composition.start_worker();
      await wait_for_sent_count(sent, 3);
    } finally {
      await composition.stop();
    }

    expect(sent.map((draft) => draft.text)).toEqual([
      expect.stringContaining("Available appointment times"),
      expect.stringContaining("confirm"),
      "Your appointment change is confirmed.",
    ]);
  });
});
