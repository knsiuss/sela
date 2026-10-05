import { describe, expect, it } from "vitest";
import { extract_channel_account_id } from "../src/meta/channel_account.js";
import {
  build_handoff_webhook,
  build_interactive_reply_webhook,
  build_legacy_button_webhook,
  build_status_webhook,
  build_text_webhook,
  FIXTURE_PHONE_NUMBER_ID,
} from "../src/meta/provider_fixtures.js";

const ACCOUNT_ID = "106540352242922";

describe("extract_channel_account_id", () => {
  it("reads the documented value.metadata.phone_number_id", () => {
    const value = { messaging_product: "whatsapp", metadata: { phone_number_id: ACCOUNT_ID } };
    expect(extract_channel_account_id(value)).toBe(ACCOUNT_ID);
  });

  it("resolves the id next to the other documented metadata fields", () => {
    const value = {
      messaging_product: "whatsapp",
      metadata: { display_phone_number: "15550783881", phone_number_id: ACCOUNT_ID },
      messages: [{ id: "wamid.doc.1", from: "15550001111", type: "text" }],
    };
    expect(extract_channel_account_id(value)).toBe(ACCOUNT_ID);
  });

  it("trims surrounding whitespace from an otherwise usable id", () => {
    expect(extract_channel_account_id({ metadata: { phone_number_id: ` ${ACCOUNT_ID} ` } })).toBe(ACCOUNT_ID);
  });

  it("ignores a top-level phone_number_id because Meta never sends one", () => {
    expect(extract_channel_account_id({ phone_number_id: ACCOUNT_ID })).toBe("");
    expect(extract_channel_account_id({ phone_number_id: ACCOUNT_ID, metadata: {} })).toBe("");
  });

  it("fails closed for missing, non-object, or unusable metadata", () => {
    expect(extract_channel_account_id(undefined)).toBe("");
    expect(extract_channel_account_id(null)).toBe("");
    expect(extract_channel_account_id("value")).toBe("");
    expect(extract_channel_account_id([])).toBe("");
    expect(extract_channel_account_id({})).toBe("");
    expect(extract_channel_account_id({ metadata: null })).toBe("");
    expect(extract_channel_account_id({ metadata: "phone_number_id" })).toBe("");
    expect(extract_channel_account_id({ metadata: {} })).toBe("");
    expect(extract_channel_account_id({ metadata: { phone_number_id: 42 } })).toBe("");
    expect(extract_channel_account_id({ metadata: { phone_number_id: "" } })).toBe("");
    expect(extract_channel_account_id({ metadata: { phone_number_id: "   " } })).toBe("");
    expect(extract_channel_account_id({ metadata: { phone_number_id: "a".repeat(257) } })).toBe("");
    expect(extract_channel_account_id({ metadata: { phone_number_id: "1555\u0007" } })).toBe("");
  });

  it("accepts an id at the resolver's own 256-character bound", () => {
    expect(extract_channel_account_id({ metadata: { phone_number_id: "a".repeat(256) } })).toHaveLength(256);
  });
});

describe("provider fixture shape", () => {
  const bodies: Record<string, string> = {
    text: build_text_webhook(),
    legacy_button: build_legacy_button_webhook(),
    interactive_reply: build_interactive_reply_webhook(),
    handoff: build_handoff_webhook(),
    status: build_status_webhook({ provider_message_id: "wamid.fixture.status.1", status: "delivered" }),
  };

  for (const [name, body] of Object.entries(bodies)) {
    it(`keeps the channel account inside metadata only in the ${name} fixture`, () => {
      const value = (JSON.parse(body)["entry"][0]["changes"][0] as { value: Record<string, unknown> }).value;
      expect(Object.hasOwn(value, "phone_number_id")).toBe(false);
      expect(extract_channel_account_id(value)).toBe(FIXTURE_PHONE_NUMBER_ID);
    });
  }

  it("writes the account id exactly once in the raw fixture bytes", () => {
    // Asserted on the serialized bytes, not only the parsed object, so a copy
    // added inside any entry, change, or status node is caught as well: the
    // documented shape carries the id in metadata and nowhere else.
    for (const body of Object.values(bodies)) {
      expect(count_account_id_fields(body)).toBe(1);
      expect(count_top_level_account_fields(body)).toBe(0);
    }
  });
});

/**
 * Count every `phone_number_id` key in the raw serialized bytes.
 *
 * @param body - Raw serialized fixture body.
 * @returns Total number of account id fields at any nesting depth.
 */
function count_account_id_fields(body: string): number {
  return body.match(/"phone_number_id"\s*:/gu)?.length ?? 0;
}

/**
 * Count top-level `phone_number_id` keys inside every `value` object.
 *
 * @param body - Raw serialized fixture body.
 * @returns How many `value` objects carry a top-level account id.
 */
function count_top_level_account_fields(body: string): number {
  const payload = JSON.parse(body) as {
    entry: { changes: { value: Record<string, unknown> }[] }[];
  };
  return payload.entry.flatMap((entry) => entry.changes)
    .filter((change) => Object.hasOwn(change.value, "phone_number_id")).length;
}