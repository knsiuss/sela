/**
 * The payload this tool signs must be one the real ingress accepts.
 *
 * Each assertion runs the agent's own `parse_inbound_messages`, so a shape
 * change on either side fails here instead of showing up as a silently
 * dropped turn in a local run.
 */

import { describe, expect, it } from "vitest";
import { parse_inbound_messages } from "appointment-agent/dist/src/webhook_handler.js";
import { parse_reschedule_button_action } from "appointment-agent/dist/src/reschedule/button_actions.js";
import {
  build_meta_button_payload,
  build_meta_text_payload,
  local_phone_number_id,
  MetaPayloadError,
  next_end_user_wa_id,
  next_wamid,
} from "../src/meta_payload.js";

const SHARED = {
  phone_number_id: local_phone_number_id(),
  wa_id: next_end_user_wa_id(1),
  wamid: next_wamid(1),
  timestamp_seconds: 1_800_000_000,
};

function serialize(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

describe("text message payload", () => {
  it("is accepted by the agent's real ingress parser", () => {
    const messages = parse_inbound_messages(serialize(build_meta_text_payload({ ...SHARED, body: "I want to book an appointment" })));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      wamid: SHARED.wamid,
      sender_phone_e164: `+${SHARED.wa_id}`,
      text_body: "I want to book an appointment",
      message_kind: "text",
    });
  });

  it("declares the WhatsApp business account object the ingress requires", () => {
    const body = serialize(build_meta_text_payload({ ...SHARED, body: "hello" }));
    expect(JSON.parse(body)["object"]).toBe("whatsapp_business_account");
  });

  it("carries the channel account only where the agent's tenant resolver reads it", () => {
    const value = JSON.parse(serialize(build_meta_text_payload({ ...SHARED, body: "hello" })))
      ["entry"][0]["changes"][0]["value"];
    // Meta's documented `messages` payload carries the channel account in
    // `value.metadata` only. A top-level copy would mask an ingress defect that
    // reads the wrong location, which is why the absence is asserted here too.
    expect(value["metadata"]["phone_number_id"]).toBe(SHARED.phone_number_id);
    expect(Object.hasOwn(value, "phone_number_id")).toBe(false);
  });

  it("carries the current unix second timestamp the worker reads as receipt time", () => {
    const body = JSON.parse(serialize(build_meta_text_payload({ ...SHARED, body: "hello" })));
    expect(body["entry"][0]["changes"][0]["value"]["messages"][0]["timestamp"]).toBe("1800000000");
  });

  it("rejects an empty body before anything is signed", () => {
    expect(() => build_meta_text_payload({ ...SHARED, body: "   " })).toThrow(MetaPayloadError);
  });

  it("rejects control characters the retained row would refuse anyway", () => {
    expect(() => build_meta_text_payload({ ...SHARED, body: "hello\u0007" })).toThrow(MetaPayloadError);
  });
});

describe("interactive button payload", () => {
  it("is accepted by the agent's real ingress parser", () => {
    const messages = parse_inbound_messages(
      serialize(build_meta_button_payload({ ...SHARED, button_id: "pick_slot_1_g1", title: "Pick slot 1" })),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      message_kind: "button_reply",
      button_id: "pick_slot_1_g1",
      text_body: "Pick slot 1",
    });
  });

  it("produces an action id the agent's own button parser accepts", () => {
    const [message] = parse_inbound_messages(
      serialize(build_meta_button_payload({ ...SHARED, button_id: "confirm_move_g1", title: "Confirm move" })),
    );
    expect(parse_reschedule_button_action(message?.button_id ?? "")).toEqual({
      kind: "confirm_move",
      generation: 1,
    });
  });

  it("rejects an action id outside the agent's wire alphabet", () => {
    expect(() => build_meta_button_payload({ ...SHARED, button_id: "Pick Slot 1", title: "x" }))
      .toThrow(MetaPayloadError);
    expect(() => build_meta_button_payload({ ...SHARED, button_id: "a".repeat(65), title: "x" }))
      .toThrow(MetaPayloadError);
  });

  it("rejects an empty label because the retained row stores it as the text", () => {
    expect(() => build_meta_button_payload({ ...SHARED, button_id: "pick_slot_1_g1", title: "  " }))
      .toThrow(MetaPayloadError);
  });
});

describe("identifier minting", () => {
  it("mints unique, bounded WAMIDs", () => {
    const ids = [1, 2, 3].map(next_wamid);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id.length).toBeLessThanOrEqual(128);
  });

  it("mints synthetic numbers that become valid E.164 senders", () => {
    for (let sequence = 1; sequence <= 3; sequence += 1) {
      const wa_id = next_end_user_wa_id(sequence);
      expect(wa_id).toMatch(/^[1-9]\d{7,14}$/u);
      expect(`+${wa_id}`).toMatch(/^\+[1-9]\d{7,14}$/u);
    }
  });

  it("refuses a sequence it cannot render safely", () => {
    expect(() => next_wamid(0)).toThrow(MetaPayloadError);
    expect(() => next_end_user_wa_id(10_000)).toThrow(MetaPayloadError);
  });
});
