/**
 * The turn gateway is the only path from a browser to the real agent.
 *
 * Its contract is honesty: an agent line exists only when the real sender
 * accepted a message, and every "nothing happened" line is derived from an
 * observed counter or an expired wait.
 */

import { describe, expect, it } from "vitest";
import type { OutboundSenderRegistry } from "appointment-agent/dist/src/worker/loop.js";
import type { OutboundDraft } from "appointment-agent/dist/src/worker/process_job.js";
import { ChatInputError, LocalChatConversation } from "../src/chat_conversation.js";
import { ChatTurnGateway } from "../src/chat_turn.js";
import { LocalChatOutboundRecorder } from "../src/outbound_recorder.js";
import type { FetchLike } from "../src/signed_delivery.js";

const SECRET = "synthetic-local-app-secret-value";

const OK = {
  request_id: "6f1c1a52-0000-4000-8000-000000000001",
  received_count: 1,
  duplicate_count: 0,
  enqueued_count: 1,
  unresolved_count: 0,
  status_count: 0,
};

const DUPLICATE = { ...OK, received_count: 1, duplicate_count: 1, enqueued_count: 0 };

interface Harness {
  gateway: ChatTurnGateway;
  recorder: LocalChatOutboundRecorder;
  sent: string[];
}

/**
 * Build a gateway whose transport stands in for the agent's HTTP ingress.
 *
 * When `reply` is supplied the fake ingress also runs "the worker" by pushing
 * one draft through the recorder, which is exactly the seam the real
 * composition uses.
 */
function harness(options: {
  ingress: () => Response;
  reply?: (inbound_wamid: string) => OutboundDraft | undefined;
}): Harness {
  const registry: OutboundSenderRegistry = {
    send: () => Promise.resolve({ status: "sent", wamid: "wamid.inmemory.1" }),
  };
  const recorder = new LocalChatOutboundRecorder(registry);
  const sent: string[] = [];
  const fetch: FetchLike = async (_url, init) => {
    const raw = String(init.body ?? "");
    sent.push(raw);
    if (options.reply !== undefined) {
      const inbound_wamid = inbound_wamid_of(raw);
      const draft = inbound_wamid === undefined ? undefined : options.reply(inbound_wamid);
      if (draft !== undefined) void recorder.send("1", draft);
    }
    return options.ingress();
  };
  const gateway = new ChatTurnGateway({
    agent_base_url: "http://127.0.0.1:3011",
    webhook_path: "/webhooks/whatsapp",
    phone_number_id: "155500000000001",
    recorder,
    app_secret: SECRET,
    fetch,
    reply_timeout_ms: 500,
    now: () => new Date(1_800_000_000_000),
  });
  return { gateway, recorder, sent };
}

function inbound_wamid_of(raw_body: string): string | undefined {
  const parsed: unknown = JSON.parse(raw_body);
  const entry = (parsed as { entry?: { changes?: { value?: { messages?: { id?: string }[] } }[] }[] }).entry?.[0];
  return entry?.changes?.[0]?.value?.messages?.[0]?.id;
}

function conversation(): LocalChatConversation {
  return new LocalChatConversation("end-user-1", "15550100001", () => new Date("2026-10-02T00:00:00.000Z"));
}

function json(status: number, value: unknown): () => Response {
  return () => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function offer_draft(inbound_wamid: string): OutboundDraft {
  return {
    to: "+15550100001",
    message_type: "text",
    text: "Available appointment times:\n1. slot",
    inbound_wamid,
    turn_id: "0",
    buttons: [{ id: "pick_slot_1_g1", label: "Pick slot 1" }],
  };
}

describe("happy path", () => {
  it("returns the agent's real reply and the observed evidence", async () => {
    const { gateway } = harness({ ingress: json(200, OK), reply: offer_draft });
    const outcome = await gateway.submit(conversation(), { kind: "text", text: "I want to book an appointment" });
    expect(outcome.evidence).toMatchObject({
      http_status: 200,
      request_id: OK.request_id,
      received_count: 1,
      enqueued_count: 1,
      provider_wamids: ["wamid.inmemory.1"],
    });
    expect(outcome.replies[0]?.text).toContain("Available appointment times");
  });

  it("makes the offered action replayable with the agent's own action id", async () => {
    const open = conversation();
    const { gateway } = harness({ ingress: json(200, OK), reply: offer_draft });
    await gateway.submit(open, { kind: "text", text: "I want to book an appointment" });
    expect(() => open.require_offered_button("pick_slot_1_g1")).not.toThrow();
  });

  it("sends a genuine signed Meta payload for a button replay", async () => {
    const open = conversation();
    const { gateway, sent } = harness({ ingress: json(200, OK), reply: offer_draft });
    await gateway.submit(open, { kind: "text", text: "I want to book an appointment" });
    await gateway.submit(open, { kind: "button", button_id: "pick_slot_1_g1" });
    const replay = JSON.parse(sent[1] ?? "{}");
    expect(replay["entry"][0]["changes"][0]["value"]["messages"][0]["interactive"]["button_reply"]["id"])
      .toBe("pick_slot_1_g1");
  });

  it("keeps the app secret out of the outcome and the transcript", async () => {
    const open = conversation();
    const { gateway } = harness({ ingress: json(200, OK), reply: offer_draft });
    const outcome = await gateway.submit(open, { kind: "text", text: "I want to book an appointment" });
    expect(JSON.stringify({ outcome, view: open.to_public_view({ tenant_id: "1", role: "end user", webhook_path: "/webhooks/whatsapp" }) }))
      .not.toContain(SECRET);
  });

  it("attaches the observed outbound wamid to the transcript evidence", async () => {
    const open = conversation();
    const { gateway } = harness({ ingress: json(200, OK), reply: offer_draft });
    await gateway.submit(open, { kind: "text", text: "I want to book an appointment" });
    const evidence = open.to_public_view({ tenant_id: "1", role: "end user", webhook_path: "/w" })
      .entries.find((entry) => entry.evidence !== undefined)?.evidence;
    expect(evidence?.provider_wamids).toEqual(["wamid.inmemory.1"]);
  });
});

describe("fail-closed paths", () => {
  it("does not wait for or invent a reply on a redelivery", async () => {
    const open = conversation();
    const { gateway } = harness({ ingress: json(200, DUPLICATE) });
    const outcome = await gateway.submit(open, { kind: "text", text: "I want to book an appointment" });
    expect(outcome.replies).toEqual([]);
    expect(outcome.evidence).toMatchObject({ duplicate_count: 1, enqueued_count: 0 });
    const system = open.to_public_view({ tenant_id: "1", role: "end user", webhook_path: "/w" })
      .entries.filter((entry) => entry.role === "system");
    expect(system[0]?.text).toContain("redelivery");
  });

  it("records a rejected signature without claiming a reply", async () => {
    const open = conversation();
    const { gateway } = harness({ ingress: json(401, { error: "unauthorized" }) });
    const outcome = await gateway.submit(open, { kind: "text", text: "I want to book an appointment" });
    expect(outcome.evidence.http_status).toBe(401);
    expect(outcome.replies).toEqual([]);
    expect(open.agent_reply_count()).toBe(0);
  });

  it("reports an unobserved reply instead of showing one", async () => {
    const open = conversation();
    const { gateway } = harness({ ingress: json(200, OK) });
    const outcome = await gateway.submit(open, { kind: "text", text: "I want to book an appointment" });
    expect(outcome.replies).toEqual([]);
    const system = open.to_public_view({ tenant_id: "1", role: "end user", webhook_path: "/w" })
      .entries.filter((entry) => entry.role === "system");
    expect(system[0]?.text).toContain("no reply was observed");
  });

  it("says so when the ingress cannot be reached, without sending anything", async () => {
    const open = conversation();
    const { gateway, sent } = harness({ ingress: () => new Response("", { status: 500 }) });
    const failing = new ChatTurnGateway({
      agent_base_url: "http://127.0.0.1:3011",
      webhook_path: "/webhooks/whatsapp",
      phone_number_id: "155500000000001",
      recorder: new LocalChatOutboundRecorder({ send: () => Promise.resolve({}) }),
      app_secret: SECRET,
      fetch: () => Promise.reject(new Error("ECONNREFUSED")),
      reply_timeout_ms: 100,
    });
    const outcome = await failing.submit(open, { kind: "text", text: "I want to book an appointment" });
    expect(outcome.reply_error).toBe("agent-unreachable");
    expect(sent).toEqual([]);
  });
});

describe("redelivery", () => {
  it("replays the previous turn byte for byte", async () => {
    const open = conversation();
    const { gateway, sent } = harness({ ingress: json(200, OK), reply: offer_draft });
    await gateway.submit(open, { kind: "text", text: "I want to book an appointment" });
    await gateway.redeliver_last(open);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
  });

  it("shows the agent's duplicate count and no second reply", async () => {
    const open = conversation();
    const { gateway, sent } = harness({ ingress: json(200, OK), reply: offer_draft });
    await gateway.submit(open, { kind: "text", text: "I want to book an appointment" });
    const replay = json(200, DUPLICATE);
    const { gateway: duplicate_gateway } = harness({ ingress: replay });
    const outcome = await duplicate_gateway.redeliver_last(open);
    expect(outcome.evidence).toMatchObject({ duplicate_count: 1, enqueued_count: 0, http_status: 200 });
    expect(outcome.replies).toEqual([]);
    expect(sent).toHaveLength(1);
  });

  it("marks the replayed line so the transcript is not misleading", async () => {
    const open = conversation();
    const { gateway } = harness({ ingress: json(200, OK), reply: offer_draft });
    await gateway.submit(open, { kind: "text", text: "I want to book an appointment" });
    await gateway.redeliver_last(open);
    const view = open.to_public_view({ tenant_id: "1", role: "end user", webhook_path: "/w" });
    expect(view.entries.filter((entry) => entry.text.startsWith("[redelivery]"))).toHaveLength(1);
  });

  it("refuses to redeliver before anything has been signed", async () => {
    const { gateway } = harness({ ingress: json(200, OK) });
    await expect(gateway.redeliver_last(conversation())).rejects.toThrow(/nothing-to-redeliver/u);
  });
});

describe("input validation", () => {
  it("refuses empty text", async () => {
    const { gateway } = harness({ ingress: json(200, OK) });
    await expect(gateway.submit(conversation(), { kind: "text", text: "   " }))
      .rejects.toBeInstanceOf(ChatInputError);
  });

  it("refuses an action the agent never offered", async () => {
    const { gateway } = harness({ ingress: json(200, OK) });
    await expect(gateway.submit(conversation(), { kind: "button", button_id: "pick_slot_1_g1" }))
      .rejects.toThrow(/button-not-offered/u);
  });
});

describe("signature self-check", () => {
  it("observes the real ingress refusing a tampered delivery", async () => {
    const open = conversation();
    const { gateway } = harness({ ingress: json(401, { error: "unauthorized" }) });
    const outcome = await gateway.run_signature_self_check(open, { kind: "text", text: "I want to book an appointment" });
    expect(outcome.evidence.http_status).toBe(401);
    expect(outcome.evidence.error).toBe("unauthorized");
    expect(open.agent_reply_count()).toBe(0);
  });
});
