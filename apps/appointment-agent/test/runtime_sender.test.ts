import { describe, expect, it } from "vitest";
import {
  build_runtime_sender,
  RuntimeSenderConfigurationError,
} from "../src/outbound/runtime_sender.js";
import type { OutboundDraft } from "../src/worker/process_job.js";

const DRAFT: OutboundDraft = {
  to: "+15551234567",
  message_type: "text",
  text: "Choose a time",
  inbound_wamid: "wamid.runtime-test",
  turn_id: "0",
};

describe("runtime sender composition", () => {
  it("requires an explicit tenant binding for database-backed credentials", () => {
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
    ).toThrow("TENANT_ID-required");
  });

  it("keeps the explicit in-memory default on tenant 1", async () => {
    const registry = build_runtime_sender({ USE_IN_MEMORY: "true" });

    await expect(registry.send("tenant-2", DRAFT)).rejects.toMatchObject({
      code: "tenant_sender_not_configured",
    });
    await expect(registry.send("1", DRAFT)).resolves.toMatchObject({ status: "sent" });
  });

  it("rejects a different tenant when a single-tenant binding is explicit", async () => {
    const registry = build_runtime_sender({
      DATABASE_URL: "postgres://test.invalid/app",
      TENANT_ID: "tenant-a",
      WHATSAPP_PHONE_NUMBER_ID: "phone-test",
      WHATSAPP_API_TOKEN: "configured-test-token",
    });

    await expect(registry.send("tenant-b", DRAFT)).rejects.toMatchObject({
      code: "tenant_sender_not_configured",
    });
  });
});
