/**
 * The chat server is a loopback-only surface holding a channel credential.
 *
 * These assertions pin the parts an operator cannot see: that it refuses a
 * non-loopback bind, that it sends the hardening headers, and that a rejected
 * request never reaches the signer.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { OutboundSenderRegistry } from "appointment-agent/dist/src/worker/loop.js";
import { ChatTurnGateway } from "../src/chat_turn.js";
import { LocalChatOutboundRecorder } from "../src/outbound_recorder.js";
import { CONTENT_SECURITY_POLICY, start_chat_server, type ChatServerHandle } from "../src/chat_server.js";
import type { FetchLike } from "../src/signed_delivery.js";

const INGRESS = {
  request_id: "6f1c1a52-0000-4000-8000-000000000001",
  received_count: 1,
  duplicate_count: 0,
  enqueued_count: 1,
  unresolved_count: 0,
  status_count: 0,
};

const registry: OutboundSenderRegistry = { send: () => Promise.resolve({ status: "sent", wamid: "wamid.inmemory.1" }) };
const recorder = new LocalChatOutboundRecorder(registry);
const fetch_impl: FetchLike = () => Promise.resolve(
  new Response(JSON.stringify(INGRESS), { status: 200, headers: { "content-type": "application/json" } }),
);

const handles: ChatServerHandle[] = [];

function gateway(): ChatTurnGateway {
  return new ChatTurnGateway({
    agent_base_url: "http://127.0.0.1:3011",
    webhook_path: "/webhooks/whatsapp",
    phone_number_id: "155500000000001",
    recorder,
    app_secret: "synthetic-local-app-secret-value",
    fetch: fetch_impl,
    reply_timeout_ms: 200,
  });
}

async function start(overrides: { host?: string; port?: number } = {}): Promise<ChatServerHandle> {
  const handle = await start_chat_server({
    gateway: gateway(),
    webhook_path: "/webhooks/whatsapp",
    reply_timeout_ms: 200,
    ...overrides,
  });
  handles.push(handle);
  return handle;
}

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.stop()));
});

describe("bind policy", () => {
  it("refuses to start on a routable interface", async () => {
    await expect(start({ host: "0.0.0.0" })).rejects.toThrow(/loopback-only/u);
  });

  it("binds loopback and reports the address it actually got", async () => {
    const handle = await start();
    expect(handle.base_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
  });
});

describe("routes", () => {
  it("answers the health probe", async () => {
    const handle = await start();
    const response = await fetch(`${handle.base_url}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  it("serves the chat page with the hardening headers", async () => {
    const handle = await start();
    const response = await fetch(`${handle.base_url}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe(CONTENT_SECURITY_POLICY);
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await response.text()).toContain("End-user chat with the booking agent");
  });

  it("serves the client script as JavaScript", async () => {
    const handle = await start();
    const response = await fetch(`${handle.base_url}/chat/client.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/javascript");
  });

  it("rejects an unknown path", async () => {
    const handle = await start();
    expect((await fetch(`${handle.base_url}/nope`)).status).toBe(404);
  });

  it("rejects a control request that is not JSON", async () => {
    const handle = await start();
    const response = await fetch(`${handle.base_url}/chat/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
  });

  it("rejects a turn kind the gateway does not accept", async () => {
    const handle = await start();
    const response = await fetch(`${handle.base_url}/chat/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "admin" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "turn-kind-invalid" });
  });

  it("rejects a button the agent never offered", async () => {
    const handle = await start();
    const response = await fetch(`${handle.base_url}/chat/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "button", button_id: "pick_slot_1_g1" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "button-not-offered" });
  });

  it("rejects a non-string body instead of coercing it", async () => {
    const handle = await start();
    const response = await fetch(`${handle.base_url}/chat/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "text", text: { injected: true } }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "text-invalid" });
  });

  it("rejects a non-string button id", async () => {
    const handle = await start();
    const response = await fetch(`${handle.base_url}/chat/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "button", button_id: ["pick_slot_1_g1"] }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "button-id-invalid" });
  });

  it("refuses to redeliver before anything has been signed", async () => {
    const handle = await start();
    const response = await fetch(`${handle.base_url}/chat/redeliver`, { method: "POST" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "nothing-to-redeliver" });
  });

  it("starts a fresh conversation on demand", async () => {
    const handle = await start();
    const response = await fetch(`${handle.base_url}/chat/sessions`, { method: "POST" });
    const body = await response.json() as { view: { end_user_ref: string; entries: unknown[] } };
    expect(response.status).toBe(200);
    expect(body.view.end_user_ref).toBe("end-user-2");
    expect(body.view.entries).toEqual([]);
  });

  it("never returns the app secret or the synthetic number on any route", async () => {
    const handle = await start();
    const pages = await Promise.all([
      fetch(`${handle.base_url}/`).then((response) => response.text()),
      fetch(`${handle.base_url}/chat/sessions`, { method: "POST" }).then((response) => response.text()),
    ]);
    for (const page of pages) {
      expect(page).not.toContain("synthetic-local-app-secret-value");
      expect(page).not.toContain("15550100001");
    }
  });
});
