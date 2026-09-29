import { describe, expect, it } from "vitest";
import {
  build_runtime_sender,
  RuntimeSenderConfigurationError,
} from "../src/outbound/runtime_sender.js";
import { is_multi_tenant_sender_registry } from "../src/outbound/sender_registry.js";
import type { OutboundDraft } from "../src/worker/process_job.js";

const DRAFT: OutboundDraft = {
  to: "+15551234567",
  message_type: "text",
  text: "Choose a time",
  inbound_wamid: "wamid.runtime-test",
  turn_id: "0",
};

describe("runtime sender composition", () => {
  it("requires an explicit per-tenant sender mapping for database-backed mode", () => {
    expect(() =>
      build_runtime_sender({
        DATABASE_URL: "postgres://test.invalid/app",
        WHATSAPP_PHONE_NUMBER_ID: "phone-test",
        WHATSAPP_API_TOKEN: "configured-test-token",
      }),
    ).toThrow(RuntimeSenderConfigurationError);
    expect(() =>
      build_runtime_sender({
        DATABASE_URL: "postgres://test.invalid/app",
        WHATSAPP_PHONE_NUMBER_ID: "phone-test",
        WHATSAPP_API_TOKEN: "configured-test-token",
      }),
    ).toThrow("tenant-sender-mapping-required");
  });

  it("keeps the explicit in-memory default on tenant 1", async () => {
    const registry = build_runtime_sender({ USE_IN_MEMORY: "true" });

    await expect(registry.send("tenant-2", DRAFT)).rejects.toMatchObject({
      code: "tenant_sender_not_configured",
    });
    await expect(registry.send("1", DRAFT)).resolves.toMatchObject({ status: "sent" });
  });

  it("resolves database senders per tenant and fails closed when unmapped", async () => {
    const registry = build_runtime_sender({
      DATABASE_URL: "postgres://test.invalid/app",
      WHATSAPP_TENANT_SENDER_REFS_JSON: JSON.stringify({
        "tenant-a": {
          phone_number_id_ref: "WHATSAPP_TENANT_A_PHONE_NUMBER_ID",
          access_token_ref: "WHATSAPP_TENANT_A_API_TOKEN",
        },
      }),
      WHATSAPP_TENANT_A_PHONE_NUMBER_ID: "phone-test",
      WHATSAPP_TENANT_A_API_TOKEN: "configured-test-token",
    });

    expect(is_multi_tenant_sender_registry(registry)).toBe(true);
    await expect(registry.send("tenant-unknown", DRAFT)).rejects.toMatchObject({
      code: "tenant_sender_not_configured",
    });
  });
});
