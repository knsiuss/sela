import { describe, expect, it, vi } from "vitest";
import {
  MetaGraphTransport,
  build_meta_payload,
  WhatsAppSendError,
  WhatsAppSender,
  type OutboundMessage,
  type WhatsAppTransport,
} from "../src/index.js";

const TEST_TOKEN = "x";

function make_transport(wamid = "wamid-1"): WhatsAppTransport & { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn().mockResolvedValue({ wamid, status: "sent" }) };
}

function make_template(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    to: "+12025550100",
    type: "template",
    template: {
      name: "appointment_reminder",
      language: { code: "en_US" },
      components: [{ type: "body", parameters: [{ type: "text", text: "2026-10-01 09:00" }] }],
    },
    ...overrides,
  };
}

describe("WhatsAppSender", () => {
  it("sends once and returns the same result for an identical retry", async () => {
    const transport = make_transport();
    const sender = new WhatsAppSender(transport);
    const message: OutboundMessage = {
      to: "+12025550100",
      type: "text",
      text: { body: "Your appointment is tomorrow" },
      inbound_wamid: "inbound-1",
      turn_id: "reply-1",
    };

    const first = await sender.send(message);
    const second = await sender.send({ ...message });
    expect(first).toEqual(second);
    expect(first.idempotency_key).toMatch(/^wa:[a-f0-9]{64}$/u);
    expect(transport.send).toHaveBeenCalledTimes(1);
    expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({ idempotency_key: first.idempotency_key }));
  });

  it("does not cache a failed transport result and permits a retry", async () => {
    const transport = {
      send: vi.fn()
        .mockResolvedValueOnce({ wamid: "wamid-failed", status: "failed" as const })
        .mockResolvedValueOnce({ wamid: "wamid-sent", status: "sent" as const }),
    };
    const sender = new WhatsAppSender(transport);
    const message: OutboundMessage = {
      to: "+12025550100",
      type: "text",
      text: { body: "Retryable message" },
      inbound_wamid: "inbound-retry",
      turn_id: "reply-1",
    };

    await expect(sender.send(message)).rejects.toMatchObject({
      name: "WhatsAppSendError",
      code: "transport_error",
      operation: "transport",
    });
    await expect(sender.send(message)).resolves.toMatchObject({ status: "sent", wamid: "wamid-sent" });
    expect(transport.send).toHaveBeenCalledTimes(2);
  });

  it("rejects free-form text when the caller requires a template", async () => {
    const transport = make_transport();
    const sender = new WhatsAppSender(transport, { template_required: true });
    await expect(
      sender.send({ to: "+12025550100", type: "text", text: { body: "Outside window" } }),
    ).rejects.toMatchObject({ code: "template_required" });
    expect(transport.send).not.toHaveBeenCalled();
  });

  it("keeps utility templates fail-closed", async () => {
    const transport = make_transport();
    const sender = new WhatsAppSender(transport);
    await expect(
      sender.send({
        to: "+12025550100",
        type: "template",
        template: { name: "not_registered", language: "en_US" },
      }),
    ).rejects.toMatchObject({ code: "template_not_registered" });
    expect(transport.send).not.toHaveBeenCalled();
  });

  it("requires an explicit policy for state-changing messages", async () => {
    const transport = make_transport();
    const sender = new WhatsAppSender(transport);
    const message = make_template({ requires_confirmation: true, is_state_changing: true });
    await expect(sender.send(message)).rejects.toMatchObject({ code: "confirmation_required" });
    expect(transport.send).not.toHaveBeenCalled();

    const allowed_sender = new WhatsAppSender(transport, { confirmation_policy: () => true });
    await expect(allowed_sender.send(message)).resolves.toMatchObject({ status: "sent" });
    expect(transport.send).toHaveBeenCalledTimes(1);
  });

  it("does not allow a per-call policy to weaken a configured gate", async () => {
    const transport = make_transport();
    const sender = new WhatsAppSender(transport, { confirmation_policy: () => false });
    await expect(
      sender.send(make_template({ requires_confirmation: true }), { confirmation_policy: () => true }),
    ).rejects.toMatchObject({ code: "confirmation_required" });
  });

  it("builds an interactive reply-button payload for an open service window", () => {
    const message: OutboundMessage = {
      to: "+12025550100",
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: "Choose a time" },
        action: {
          buttons: [{ button_id: "pick_slot_1", label: "Pick slot 1", type: "quick_reply", payload: "pick_slot_1" }],
        },
      },
    };

    expect(build_meta_payload(message)).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "+12025550100",
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: "Choose a time" },
        action: {
          buttons: [{ type: "reply", reply: { id: "pick_slot_1", title: "Pick slot 1" } }],
        },
      },
    });
  });

  it("converts application buttons into allow-listed template components", async () => {
    const fetch_mock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ messages: [{ id: "wamid-template" }] }), { status: 200 }),
    );
    const transport = new MetaGraphTransport({
      graph_api_url: "https://graph.example.test/v1.0",
      allowed_hosts: ["graph.example.test"],
      phone_number_id: "phone-1",
      access_token: TEST_TOKEN,
      fetch: fetch_mock,
    });
    await transport.send(
      make_template({
        buttons: [{ button_id: "confirm", label: "Confirm appointment", payload: "confirm" }],
      }),
    );
    const body = JSON.parse(String(fetch_mock.mock.calls[0]?.[1]?.body));
    expect(body.template.components).toHaveLength(2);
    expect(body.template.components[1]).toEqual({
      type: "button",
      sub_type: "quick_reply",
      index: "0",
      parameters: [{ type: "payload", payload: "confirm" }],
    });
  });
});

describe("MetaGraphTransport", () => {
  it("uses native fetch with bounded AbortSignal and parses the outbound WAMID", async () => {
    const fetch_mock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ messages: [{ id: "wamid-2" }] }), { status: 200 }),
    );
    const transport = new MetaGraphTransport({
      graph_api_url: "https://graph.example.test/v1.0/",
      allowed_hosts: ["graph.example.test"],
      phone_number_id: "phone-2",
      access_token: TEST_TOKEN,
      request_timeout_ms: 250,
      fetch: fetch_mock,
    });
    await expect(
      transport.send({ to: "+12025550100", type: "text", text: { body: "Hello" } }),
    ).resolves.toEqual({ wamid: "wamid-2" });
    const [url, init] = fetch_mock.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://graph.example.test/v1.0/phone-2/messages");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${TEST_TOKEN}`);
    expect(JSON.parse(String(init?.body))).toMatchObject({ messaging_product: "whatsapp", type: "text" });
  });

  it("rejects a non-allowlisted Graph origin before sending a token", () => {
    expect(() => new MetaGraphTransport({
      graph_api_url: "https://evil.example/v1.0",
      phone_number_id: "phone-unsafe",
      access_token: TEST_TOKEN,
    })).toThrow("Meta Graph API host is not allowlisted");
  });

  it("disables redirects on the token-bearing request", async () => {
    const fetch_mock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ messages: [{ id: "wamid-redirect-safe" }] }), { status: 200 }),
    );
    const transport = new MetaGraphTransport({
      graph_api_url: "https://graph.example.test/v1.0",
      allowed_hosts: ["graph.example.test"],
      phone_number_id: "phone-redirect",
      access_token: TEST_TOKEN,
      fetch: fetch_mock,
    });
    await transport.send({ to: "+12025550100", type: "text", text: { body: "Hello" } });
    expect(fetch_mock.mock.calls[0]?.[1]?.redirect).toBe("error");
  });

  it("sanitizes upstream errors and never retries", async () => {
    const fetch_mock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: 131009, reason: TEST_TOKEN, message: `private ${TEST_TOKEN} body` } }),
        { status: 400 },
      ),
    );
    const transport = new MetaGraphTransport({
      graph_api_url: "https://graph.example.test/v1.0",
      allowed_hosts: ["graph.example.test"],
      phone_number_id: "phone-3",
      access_token: TEST_TOKEN,
      fetch: fetch_mock,
    });
    try {
      await transport.send({ to: "+12025550100", type: "text", text: { body: "Hello" } });
      throw new Error("expected upstream failure");
    } catch (error) {
      expect(error).toBeInstanceOf(WhatsAppSendError);
      expect(error).toMatchObject({ code: "upstream_error", status: 400, upstream_code: "131009" });
      expect(String((error as WhatsAppSendError).message)).not.toContain(TEST_TOKEN);
      expect(String((error as WhatsAppSendError).message)).not.toContain("private");
    }
    expect(fetch_mock).toHaveBeenCalledTimes(1);
  });

  it("does not expose token-shaped provider error codes", async () => {
    const token_shaped_code = "EAA-secret-token-value";
    const fetch_mock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: token_shaped_code, error_subcode: token_shaped_code } }),
        { status: 400 },
      ),
    );
    const transport = new MetaGraphTransport({
      graph_api_url: "https://graph.example.test/v1.0",
      allowed_hosts: ["graph.example.test"],
      phone_number_id: "phone-token-code",
      access_token: TEST_TOKEN,
      fetch: fetch_mock,
    });

    try {
      await transport.send({ to: "+12025550100", type: "text", text: { body: "Hello" } });
      throw new Error("expected upstream failure");
    } catch (error) {
      expect(error).toBeInstanceOf(WhatsAppSendError);
      expect((error as WhatsAppSendError).upstream_code).toBeUndefined();
      expect(JSON.stringify(error)).not.toContain(token_shaped_code);
    }
  });

  it("translates timeout and malformed response failures", async () => {
    const timeout_transport = new MetaGraphTransport({
      graph_api_url: "https://graph.example.test/v1.0",
      allowed_hosts: ["graph.example.test"],
      phone_number_id: "phone-4",
      access_token: TEST_TOKEN,
      fetch: vi.fn().mockRejectedValue(new DOMException("private timeout", "TimeoutError")),
    });
    await expect(
      timeout_transport.send({ to: "+12025550100", type: "text", text: { body: "Hello" } }),
    ).rejects.toMatchObject({ code: "request_timeout" });

    const invalid_transport = new MetaGraphTransport({
      graph_api_url: "https://graph.example.test/v1.0",
      allowed_hosts: ["graph.example.test"],
      phone_number_id: "phone-5",
      access_token: TEST_TOKEN,
      fetch: vi.fn().mockResolvedValue(new Response("not-json", { status: 200 })),
    });
    await expect(
      invalid_transport.send({ to: "+12025550100", type: "text", text: { body: "Hello" } }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
});
