import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryMessageDedupe } from "../src/ingress/dedupe.js";
import { InMemoryTenantResolver } from "../src/ingress/tenant_resolver.js";
import { InMemoryOutboundLedgerStore } from "../src/outbound/outbound_ledger.js";
import { handle_inbound_request } from "../src/webhook_handler.js";

const APP_SECRET = "status-app-secret";

function signature_for(body: string): string {
  return `sha256=${createHmac("sha256", APP_SECRET).update(body).digest("hex")}`;
}

describe("WhatsApp outbound status ingestion", () => {
  it("persists signed delivery callbacks without retaining recipient data", async () => {
    const ledger = new InMemoryOutboundLedgerStore();
    const claim = await ledger.begin({
      tenant_id: "42",
      provider: "whatsapp",
      operation_key: "status-webhook-operation",
      request_fingerprint: "b".repeat(64),
    });
    if (claim.kind !== "send") throw new Error("claim setup failed");
    await ledger.mark_sent({
      tenant_id: "42",
      provider: "whatsapp",
      operation_key: "status-webhook-operation",
      lease_token: claim.lease_token,
      provider_message_id: "wamid.status.webhook",
    });
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{
        changes: [{
          value: {
            phone_number_id: "phone-status",
            statuses: [{
              id: "wamid.status.webhook",
              status: "delivered",
              timestamp: "1780000000",
            }],
          },
        }],
      }],
    });

    const result = await handle_inbound_request(
      body,
      signature_for(body),
      APP_SECRET,
      new InMemoryMessageDedupe(),
      { enqueue: async () => undefined },
      {
        tenant_resolver: new InMemoryTenantResolver({ "phone-status": "42" }),
        outbound_ledger: ledger,
      },
    );

    expect(result).toMatchObject({
      received_count: 0,
      status_count: 1,
      status_updated_count: 1,
    });
    expect(ledger.get("42", "whatsapp", "status-webhook-operation")).toMatchObject({
      status: "delivered",
      provider_message_id: "wamid.status.webhook",
    });
  });
});
