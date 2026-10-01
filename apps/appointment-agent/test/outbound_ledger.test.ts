import { describe, expect, it, vi } from "vitest";
import {
  derive_outbound_operation_key,
  InMemoryOutboundLedgerStore,
  OutboundLedgerError,
  OutboundLedgerUnknownError,
} from "../src/outbound/outbound_ledger.js";
import { DurableOutboundSenderRegistry } from "../src/outbound/durable_outbound_registry.js";
import { InMemoryTenantRateLimiter } from "../src/rate_limit/tenant_rate_limiter.js";
import type { OutboundDraft } from "../src/worker/process_job.js";

const DRAFT: OutboundDraft = {
  to: "+15551234567",
  text: "A safe reply",
  message_type: "text",
  inbound_wamid: "wamid-outbound-test",
  turn_id: "0",
  idempotency_key: "wa:outbound-test",
};
const DRAFT_OPERATION_KEY = derive_outbound_operation_key("42", DRAFT);

describe("durable outbound ledger", () => {
  it("replays a committed provider result without a second provider call", async () => {
    const ledger = new InMemoryOutboundLedgerStore();
    const send = vi.fn(async () => ({ status: "sent", wamid: "wamid.provider.1" }));
    const registry = new DurableOutboundSenderRegistry({
      registry: { send },
      ledger,
      provider: "whatsapp",
    });

    await expect(registry.send("42", DRAFT)).resolves.toEqual({
      status: "sent",
      wamid: "wamid.provider.1",
      replayed: false,
    });
    await expect(registry.send("42", DRAFT)).resolves.toEqual({
      status: "sent",
      wamid: "wamid.provider.1",
      replayed: true,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(ledger.get("42", "whatsapp", DRAFT_OPERATION_KEY)).toMatchObject({
      status: "sent",
      provider_message_id: "wamid.provider.1",
    });
  });

  it("marks an invalid provider acknowledgement as a terminal ledger failure", async () => {
    const ledger = new InMemoryOutboundLedgerStore();
    const registry = new DurableOutboundSenderRegistry({
      registry: { send: vi.fn(async () => ({ status: "sent", wamid: " wamid.invalid" })) },
      ledger,
      provider: "whatsapp",
    });

    await expect(registry.send("42", DRAFT)).rejects.toMatchObject({ code: "outbound_provider_ack_invalid" });
    expect(ledger.get("42", "whatsapp", DRAFT_OPERATION_KEY)).toMatchObject({
      status: "failed",
      error_code: "outbound_provider_ack_invalid",
      retryable: false,
    });
  });

  it("rejects semantic drift when an operation key is reused", async () => {
    const ledger = new InMemoryOutboundLedgerStore();
    const send = vi.fn(async () => ({ status: "sent", wamid: "wamid.drift.1" }));
    const registry = new DurableOutboundSenderRegistry({ registry: { send }, ledger, provider: "whatsapp" });
    await registry.send("42", DRAFT);
    await expect(registry.send("42", { ...DRAFT, text: "different content" })).rejects.toMatchObject({
      name: "OutboundLedgerConflictError",
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("fences ambiguous provider timeouts as unknown and never resends automatically", async () => {
    const ledger = new InMemoryOutboundLedgerStore();
    const send = vi.fn(async () => {
      throw { code: "request_timeout" };
    });
    const registry = new DurableOutboundSenderRegistry({ registry: { send }, ledger, provider: "whatsapp" });

    await expect(registry.send("42", DRAFT)).rejects.toBeTruthy();
    expect(ledger.get("42", "whatsapp", DRAFT_OPERATION_KEY)).toMatchObject({
      status: "unknown",
      error_code: "request_timeout",
    });
    await expect(registry.send("42", DRAFT)).rejects.toBeInstanceOf(OutboundLedgerUnknownError);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("keeps partial draft success safe when a later draft is rate limited", async () => {
    let now_ms = 0;
    const ledger = new InMemoryOutboundLedgerStore(() => now_ms);
    const limiter = new InMemoryTenantRateLimiter(() => now_ms);
    const send = vi.fn(async () => ({ status: "sent", wamid: "wamid.partial.1" }));
    const registry = new DurableOutboundSenderRegistry({
      registry: { send },
      ledger,
      rate_limiter: limiter,
      outbound_limit: 1,
      outbound_window_seconds: 60,
      provider: "whatsapp",
    });
    const second = { ...DRAFT, idempotency_key: "wa:outbound-test-2", turn_id: "1" };

    await expect(registry.send("42", DRAFT)).resolves.toMatchObject({ replayed: false });
    await expect(registry.send("42", second)).rejects.toMatchObject({ name: "RateLimitExceededError" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(ledger.get("42", "whatsapp", derive_outbound_operation_key("42", second))).toMatchObject({
      status: "failed",
      retryable: true,
      error_code: "rate_limited",
    });
    now_ms += 60_001;
    await expect(registry.send("42", second)).resolves.toMatchObject({ replayed: false });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("applies provider statuses monotonically and ignores duplicate callbacks", async () => {
    const ledger = new InMemoryOutboundLedgerStore();
    const claim = await ledger.begin({
      tenant_id: "42",
      provider: "whatsapp",
      operation_key: "status-operation",
      request_fingerprint: "a".repeat(64),
    });
    await ledger.mark_sent({
      tenant_id: "42",
      provider: "whatsapp",
      operation_key: "status-operation",
      lease_token: claim.kind === "send" ? claim.lease_token : "",
      provider_message_id: "wamid.status.1",
    });

    await expect(ledger.record_status("42", {
      provider: "whatsapp",
      provider_message_id: "wamid.status.1",
      status: "delivered",
    })).resolves.toBe("updated");
    await expect(ledger.record_status("42", {
      provider: "whatsapp",
      provider_message_id: "wamid.status.1",
      status: "sent",
    })).resolves.toBe("duplicate");
    await expect(ledger.record_status("42", {
      provider: "whatsapp",
      provider_message_id: "wamid.status.1",
      status: "read",
    })).resolves.toBe("updated");
    expect(ledger.get("42", "whatsapp", "status-operation")).toMatchObject({
      status: "read",
      delivered_at: expect.any(String),
      read_at: expect.any(String),
    });
  });

  it("does not partially mutate a status row when an error code is invalid", async () => {
    const ledger = new InMemoryOutboundLedgerStore();
    const claim = await ledger.begin({
      tenant_id: "42",
      provider: "whatsapp",
      operation_key: "invalid-status-operation",
      request_fingerprint: "e".repeat(64),
    });
    if (claim.kind !== "send") throw new Error("status claim setup failed");
    await ledger.mark_sent({
      tenant_id: "42",
      provider: "whatsapp",
      operation_key: "invalid-status-operation",
      lease_token: claim.lease_token,
      provider_message_id: "wamid.invalid-status.1",
    });

    await expect(ledger.record_status("42", {
      provider: "whatsapp",
      provider_message_id: "wamid.invalid-status.1",
      status: "delivered",
      error_code: "not a safe code",
    })).rejects.toBeInstanceOf(OutboundLedgerError);
    expect(ledger.get("42", "whatsapp", "invalid-status-operation")).toMatchObject({
      status: "sent",
      error_code: null,
    });
  });
});
