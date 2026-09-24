import { describe, expect, it } from "vitest";
import { InMemoryTransport, WhatsAppSendError, WhatsAppSender } from "@repo/wa-sender";
import { WhatsAppSenderAdapter } from "../src/outbound/whatsapp_sender_adapter.js";

const DRAFT = {
  to: "+15551234567",
  message_type: "text" as const,
  text: "Choose a time",
  buttons: [{ id: "pick_slot_1", label: "Pick slot 1", payload: "pick_slot_1" }],
  idempotency_key: "wamid-1:0",
  inbound_wamid: "wamid-1",
  turn_id: "0",
};

describe("WhatsAppSenderAdapter", () => {
  it("converts button drafts into an interactive Meta message", async () => {
    const transport = new InMemoryTransport();
    const adapter = new WhatsAppSenderAdapter(new WhatsAppSender(transport));

    await adapter.send(DRAFT);

    expect(transport.messages()[0]).toMatchObject({
      to: DRAFT.to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: "Choose a time" },
        action: {
          buttons: [{ button_id: "pick_slot_1", label: "Pick slot 1" }],
        },
      },
    });
  });

  it("converts a plain draft into a text message", async () => {
    const transport = new InMemoryTransport();
    const adapter = new WhatsAppSenderAdapter(new WhatsAppSender(transport));

    await adapter.send({ ...DRAFT, buttons: undefined });

    expect(transport.messages()[0]).toMatchObject({ type: "text", text: { body: "Choose a time" } });
  });

  it("propagates a provider failure as a retryable sender error", async () => {
    const sender = new WhatsAppSender({
      send: async () => ({ wamid: "wamid.failed", status: "failed" as const }),
    });
    const adapter = new WhatsAppSenderAdapter(sender);

    const error = await adapter.send({ ...DRAFT, buttons: undefined }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(WhatsAppSendError);
    expect(error).toMatchObject({ code: "transport_error" });
  });

  it("rejects an unconfirmed state-changing draft before transport", async () => {
    const transport = new InMemoryTransport();
    const adapter = new WhatsAppSenderAdapter(new WhatsAppSender(transport));

    await expect(
      adapter.send({ ...DRAFT, buttons: undefined, is_state_changing: true }),
    ).rejects.toMatchObject({
      name: "OutboundDraftError",
      code: "state-changing-confirmation-evidence-unavailable",
    });
    expect(transport.messages()).toHaveLength(0);
  });

  it("fails closed when only a boolean confirmation hint is present", async () => {
    const transport = new InMemoryTransport();
    const sender = new WhatsAppSender(transport, { confirmation_policy: () => true });
    const adapter = new WhatsAppSenderAdapter(sender);

    await expect(
      adapter.send({
        ...DRAFT,
        buttons: undefined,
        is_state_changing: true,
        customer_confirmed: true,
      }),
    ).rejects.toMatchObject({
      name: "OutboundDraftError",
      code: "state-changing-confirmation-evidence-unavailable",
    });
    expect(transport.messages()).toHaveLength(0);
  });
});
