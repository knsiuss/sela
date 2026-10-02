/**
 * The recorder is the only place this tool sees what the agent replied.
 *
 * The PII assertions matter more than the happy path: a recorder that kept the
 * transient recipient would make every local transcript a place where a phone
 * number can be retained and, eventually, printed.
 */

import { describe, expect, it } from "vitest";
import type { OutboundSenderRegistry } from "appointment-agent/dist/src/worker/loop.js";
import type { OutboundDraft } from "appointment-agent/dist/src/worker/process_job.js";
import { LocalChatOutboundRecorder, MAX_RECORDED_REPLIES } from "../src/outbound_recorder.js";

const RECIPIENT = "+15550100001";

function stub_registry(wamid = "wamid.inmemory.1"): OutboundSenderRegistry {
  return {
    send: () => Promise.resolve({ status: "sent", wamid }),
  };
}

function draft(overrides: Partial<OutboundDraft> = {}): OutboundDraft {
  return {
    to: RECIPIENT,
    message_type: "text",
    text: "Available appointment times:\n1. 2026-10-03T09:00:00.000Z",
    inbound_wamid: "wamid.LOCAL.000001",
    turn_id: "0",
    idempotency_key: "reschedule-confirm-v1:abcdef",
    buttons: [{ id: "pick_slot_1_g1", label: "Pick slot 1" }],
    ...overrides,
  };
}

describe("outbound observation", () => {
  it("forwards to the real sender and returns its acknowledgement unchanged", async () => {
    const recorder = new LocalChatOutboundRecorder(stub_registry("wamid.inmemory.7"));
    const result = await recorder.send("1", draft());
    expect(result).toEqual({ status: "sent", wamid: "wamid.inmemory.7" });
    expect(recorder.total_sent()).toBe(1);
  });

  it("records the reply the transport accepted, with its provider wamid", async () => {
    const recorder = new LocalChatOutboundRecorder(stub_registry("wamid.inmemory.3"));
    await recorder.send("1", draft());
    expect(recorder.replies_for("wamid.LOCAL.000001")).toEqual([
      {
        inbound_wamid: "wamid.LOCAL.000001",
        turn_id: "0",
        message_type: "text",
        text: "Available appointment times:\n1. 2026-10-03T09:00:00.000Z",
        buttons: [{ id: "pick_slot_1_g1", label: "Pick slot 1" }],
        provider_wamid: "wamid.inmemory.3",
        sent_at_iso: expect.any(String),
      },
    ]);
  });

  it("never retains the transient recipient or the derived idempotency key", async () => {
    const recorder = new LocalChatOutboundRecorder(stub_registry());
    await recorder.send("1", draft());
    const retained = JSON.stringify(recorder.replies_for("wamid.LOCAL.000001"));
    expect(retained).not.toContain(RECIPIENT);
    expect(retained).not.toContain("idempotency_key");
    expect(retained).not.toContain("reschedule-confirm-v1");
  });

  it("keeps replies separated by inbound WAMID", async () => {
    const recorder = new LocalChatOutboundRecorder(stub_registry());
    await recorder.send("1", draft({ inbound_wamid: "wamid.LOCAL.000001" }));
    await recorder.send("1", draft({ inbound_wamid: "wamid.LOCAL.000002", text: "second" }));
    expect(recorder.replies_for("wamid.LOCAL.000001")[0]?.text).toContain("Available");
    expect(recorder.replies_for("wamid.LOCAL.000002")[0]?.text).toBe("second");
  });

  it("resolves the wait as soon as a reply for that WAMID arrives", async () => {
    const recorder = new LocalChatOutboundRecorder(stub_registry());
    setTimeout(() => void recorder.send("1", draft()), 20);
    const replies = await recorder.wait_for_replies("wamid.LOCAL.000001", 1_000);
    expect(replies).toHaveLength(1);
  });

  it("returns nothing rather than inventing a reply when the worker is silent", async () => {
    const recorder = new LocalChatOutboundRecorder(stub_registry());
    expect(await recorder.wait_for_replies("wamid.LOCAL.000001", 60)).toEqual([]);
  });

  it("does not notice a reply addressed to a different turn", async () => {
    const recorder = new LocalChatOutboundRecorder(stub_registry());
    await recorder.send("1", draft({ inbound_wamid: "wamid.LOCAL.000009" }));
    expect(await recorder.wait_for_replies("wamid.LOCAL.000001", 60)).toEqual([]);
  });

  it("bounds how many replies it retains", async () => {
    const recorder = new LocalChatOutboundRecorder(stub_registry());
    for (let index = 0; index <= MAX_RECORDED_REPLIES; index += 1) {
      await recorder.send("1", draft({ inbound_wamid: `wamid.LOCAL.${index}` }));
    }
    expect(recorder.replies_for("wamid.LOCAL.000000")).toEqual([]);
    expect(recorder.replies_for(`wamid.LOCAL.${MAX_RECORDED_REPLIES}`)).toHaveLength(1);
  });
});
