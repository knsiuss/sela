import { describe, expect, it, vi } from "vitest";
import {
  MappedOutboundSenderRegistry,
  OutboundSenderRegistryError,
  SingleTenantOutboundSenderRegistry,
} from "../src/outbound/sender_registry.js";
import type { OutboundDraft } from "../src/worker/process_job.js";
import type { OutboundSenderPort } from "../src/worker/loop.js";

const DRAFT: OutboundDraft = {
  to: "+15551234567",
  message_type: "text",
  text: "Choose a time",
  inbound_wamid: "wamid.registry-test",
  turn_id: "0",
};

function make_sender(): { sender: OutboundSenderPort; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn(async () => ({ status: "sent" }));
  return { sender: { send }, send };
}

describe("outbound sender registry", () => {
  it("routes tenant A and tenant B through their own sender adapters", async () => {
    const tenant_a = make_sender();
    const tenant_b = make_sender();
    const registry = new MappedOutboundSenderRegistry(new Map([
      ["tenant-a", tenant_a.sender],
      ["tenant-b", tenant_b.sender],
    ]));

    await registry.send("tenant-a", DRAFT);
    await registry.send("tenant-b", { ...DRAFT, text: "Tenant B reply" });

    expect(tenant_a.send).toHaveBeenCalledWith(DRAFT);
    expect(tenant_b.send).toHaveBeenCalledWith(expect.objectContaining({ text: "Tenant B reply" }));
    expect(tenant_a.send).toHaveBeenCalledTimes(1);
    expect(tenant_b.send).toHaveBeenCalledTimes(1);
  });

  it("rejects reusing one sender object across tenant bindings", () => {
    const sender = make_sender().sender;

    expect(() => new MappedOutboundSenderRegistry(new Map([
      ["tenant-a", sender],
      ["tenant-b", sender],
    ]))).toThrow("sender-reuse");
  });

  it("fails closed without provider I/O for an unmapped tenant", async () => {
    const tenant_a = make_sender();
    const registry = new MappedOutboundSenderRegistry(new Map([["tenant-a", tenant_a.sender]]));

    const error = await registry.send("tenant-b", DRAFT).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(OutboundSenderRegistryError);
    expect(error).toMatchObject({ code: "tenant_sender_not_configured" });
    expect((error as Error).message).not.toContain("tenant-b");
    expect(tenant_a.send).not.toHaveBeenCalled();
  });

  it("rejects an invalid per-sender binding at construction", () => {
    const invalid_sender = {} as unknown as OutboundSenderPort;

    expect(() => new SingleTenantOutboundSenderRegistry("tenant-a", invalid_sender)).toThrow(
      "registry-invalid",
    );
  });

  it("does not send a single-tenant pilot through its sender for another tenant", async () => {
    const sender = make_sender();
    const registry = new SingleTenantOutboundSenderRegistry("tenant-a", sender.sender);

    await expect(registry.send("tenant-b", DRAFT)).rejects.toMatchObject({
      code: "tenant_sender_not_configured",
    });
    expect(sender.send).not.toHaveBeenCalled();
  });
});
