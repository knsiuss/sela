import { describe, expect, it } from "vitest";
import { build_composition } from "../src/composition.js";
import { build_inbound_message_record } from "../src/ingress/inbound_store.js";
import type { OutboundDraft } from "../src/worker/process_job.js";

const PHONE = "+15551234567";
const PHONE_NUMBER_ID = "phone-routing";

type RoutedSend = { tenant_id: string; draft: OutboundDraft };

async function wait_for_count(count: number, sends: readonly RoutedSend[]): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (sends.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (sends.length < count) throw new Error("sender-timeout");
}

describe("composition tenant sender routing", () => {
  it("passes tenant A and tenant B to an injected registry", async () => {
    const sends: RoutedSend[] = [];
    const composition = build_composition({
      env: {
        USE_IN_MEMORY: "true",
        TENANT_ID: "tenant-a",
        WHATSAPP_PHONE_NUMBER_ID: PHONE_NUMBER_ID,
        WORKER_POLL_INTERVAL_MS: "5",
        WORKER_BATCH_SIZE: "2",
      },
      sender_registry: {
        send: async (tenant_id, draft) => {
          sends.push({ tenant_id, draft });
          return { status: "sent" };
        },
      },
    });

    try {
      for (const [tenant_id, wamid] of [["tenant-a", "wamid.route-a"], ["tenant-b", "wamid.route-b"]]) {
        const received_at = new Date().toISOString();
        const record = build_inbound_message_record({
          tenant_id,
          recipient_cipher: composition.recipient_cipher,
          conversation_id: `conversation-${tenant_id}`,
          message: {
            wamid,
            sender_phone_e164: PHONE,
            text_body: "I need help",
            message_kind: "text",
            sent_at_iso: received_at,
          },
          now: received_at,
        });
        await composition.inbound_store.save(record);
        await composition.job_queue.enqueue({
          request_id: `request-${tenant_id}`,
          wamid,
          conversation_id: record.conversation_id,
          received_at_iso: record.received_at,
          tenant_id,
        });
      }

      composition.start_worker();
      await wait_for_count(2, sends);
    } finally {
      await composition.stop();
    }

    expect(sends.map(({ tenant_id }) => tenant_id)).toEqual(["tenant-a", "tenant-b"]);
    expect(sends[0]?.draft.text).toContain("team");
    expect(sends[1]?.draft.text).toContain("team");
  });
});
