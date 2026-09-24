import { describe, expect, it, vi } from "vitest";
import {
  build_inbound_message_record,
  InMemoryInboundMessageStore,
  InboundMessageStoreError,
  PostgresInboundMessageStore,
} from "../src/ingress/inbound_store.js";
import type { InboundMessage } from "../src/agent_types.js";
import type { SqlClient } from "../src/persistence/sql_client.js";
import { AesGcmRecipientCipher } from "../src/security/recipient_cipher.js";

const RECIPIENT_CIPHER = new AesGcmRecipientCipher(Buffer.alloc(32, 3));
const SERVER_RECEIVED_AT = "2026-09-24T08:00:00.000Z";

const MESSAGE: InboundMessage = {
  wamid: "wamid.inbound-test",
  sender_phone_e164: "+15551234567",
  text_body: "I need an appointment",
  message_kind: "text",
  sent_at_iso: "2026-09-24T08:00:00.000Z",
};

function record(tenant_id = "42", retention_days?: number) {
  return build_inbound_message_record({
    tenant_id,
    message: MESSAGE,
    recipient_cipher: RECIPIENT_CIPHER,
    conversation_id: "conversation-test",
    sender_ref: "sender-reference-test",
    retention_days,
    now: SERVER_RECEIVED_AT,
  });
}

describe("inbound message store", () => {
  it("retains the button action id for deterministic follow-up turns", () => {
    const result = build_inbound_message_record({
      tenant_id: "42",
      message: {
        ...MESSAGE,
        wamid: "wamid.button-test",
        message_kind: "button_reply",
        button_id: "pick_slot_1",
        text_body: "Pick slot 1",
      },
      recipient_cipher: RECIPIENT_CIPHER,
      conversation_id: "conversation-button-test",
    });

    expect(result).toMatchObject({
      wamid: "wamid.button-test",
      message_type: "button_reply",
      button_id: "pick_slot_1",
    });
  });

  it("retains an encrypted reply target and applies the retention deadline", () => {
    const result = record("42", 7);

    expect(result).toMatchObject({
      tenant_id: "42",
      wamid: MESSAGE.wamid,
      sender_ref: "sender-reference-test",
      expires_at: "2026-10-01T08:00:00.000Z",
    });
    expect(result.reply_target_ciphertext).toMatch(/^v1\./);
    expect(RECIPIENT_CIPHER.decrypt(result.reply_target_ciphertext!)).toBe(MESSAGE.sender_phone_e164);
    expect(JSON.stringify(result)).not.toContain(MESSAGE.sender_phone_e164);
  });

  it("bases retention on server receipt for stale and future provider timestamps", () => {
    const provider_timestamps = [
      "2026-09-01T08:00:00.000Z",
      "2026-09-25T12:00:00.000Z",
    ];

    for (const provider_timestamp of provider_timestamps) {
      const result = build_inbound_message_record({
        tenant_id: "42",
        message: { ...MESSAGE, sent_at_iso: provider_timestamp },
        recipient_cipher: RECIPIENT_CIPHER,
        conversation_id: "conversation-time-test",
        retention_days: 7,
        now: "2026-09-24T12:00:00.000Z",
      });

      expect(result.received_at).toBe(provider_timestamp);
      expect(result.expires_at).toBe("2026-10-01T12:00:00.000Z");
      expect(result.reply_target_ciphertext).toMatch(/^v1\./);
      expect(RECIPIENT_CIPHER.decrypt(result.reply_target_ciphertext!)).toBe(MESSAGE.sender_phone_e164);
      expect(JSON.stringify(result)).not.toContain(MESSAGE.sender_phone_e164);
    }
  });

  it("rejects an invalid server receipt timestamp", () => {
    expect(() =>
      build_inbound_message_record({
        tenant_id: "42",
        message: MESSAGE,
        recipient_cipher: RECIPIENT_CIPHER,
        conversation_id: "conversation-time-test",
        now: "not-a-timestamp",
      }),
    ).toThrow(InboundMessageStoreError);
  });

  it("deduplicates by tenant and wamid while allowing another tenant", async () => {
    const store = new InMemoryInboundMessageStore();

    await expect(store.save(record("42"))).resolves.toBe(true);
    await expect(store.save(record("42"))).resolves.toBe(false);
    await expect(store.save(record("43"))).resolves.toBe(true);
    expect(store.all()).toHaveLength(2);
  });

  it("loads and marks a row without changing its retained content", async () => {
    const store = new InMemoryInboundMessageStore();
    await store.save(record());

    const loaded = await store.get("42", MESSAGE.wamid);
    expect(loaded).toMatchObject({ message_text: MESSAGE.text_body, processed_at: null });
    await store.mark_processed("42", MESSAGE.wamid, "2026-09-24T08:05:00.000Z");

    expect(await store.get("42", MESSAGE.wamid)).toMatchObject({
      processed_at: "2026-09-24T08:05:00.000Z",
      message_text: MESSAGE.text_body,
    });
  });

  it("uses bound values for Postgres insert, read, and processed updates", async () => {
    const query = vi.fn(async (sql: string, _values?: readonly unknown[]) => {
      if (sql.includes("INSERT INTO inbound_messages")) return { rows: [{ id: 1 }], rowCount: 1 };
      return {
        rows: [
          {
            tenant_id: "42",
            wamid: MESSAGE.wamid,
            conversation_id: "conversation-test",
            message_type: "text",
            button_id: null,
            sender_ref: "sender-reference-test",
            reply_target_ciphertext: RECIPIENT_CIPHER.encrypt(MESSAGE.sender_phone_e164),
            message_text: MESSAGE.text_body,
            received_at: "2026-09-24T08:00:00.000Z",
            expires_at: "2026-10-24T08:00:00.000Z",
            processed_at: null,
          },
        ],
        rowCount: 1,
      };
    });
    const store = new PostgresInboundMessageStore({ query } satisfies SqlClient);
    const saved = record();

    await expect(store.save(saved)).resolves.toBe(true);
    await expect(store.get("42", MESSAGE.wamid)).resolves.toMatchObject({ wamid: MESSAGE.wamid });
    await store.mark_processed("42", MESSAGE.wamid, "2026-09-24T08:05:00.000Z");

    expect(query.mock.calls[0]?.[0]).toContain("reply_target_ciphertext");
    expect(query.mock.calls[1]?.[0]).toContain("reply_target_ciphertext");
    expect(query.mock.calls[0]?.[1]).toEqual([
      "42",
      MESSAGE.wamid,
      "conversation-test",
      "text",
      null,
      "sender-reference-test",
      saved.reply_target_ciphertext,
      MESSAGE.text_body,
      saved.received_at,
      saved.expires_at,
    ]);
    expect(query.mock.calls[1]?.[1]).toEqual(["42", MESSAGE.wamid]);
    expect(query.mock.calls[2]?.[1]).toEqual(["42", MESSAGE.wamid, "2026-09-24T08:05:00.000Z"]);
    for (const [sql, values] of query.mock.calls) {
      expect(sql).not.toContain(MESSAGE.sender_phone_e164);
      expect(JSON.stringify(values)).not.toContain(MESSAGE.sender_phone_e164);
    }
  });

  it("loads a legacy database row with a missing encrypted reply target", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          tenant_id: "42",
          wamid: MESSAGE.wamid,
          conversation_id: "conversation-test",
          message_type: "text",
          sender_ref: "sender-reference-test",
          reply_target_ciphertext: null,
          message_text: MESSAGE.text_body,
          received_at: "2026-09-24T08:00:00.000Z",
          expires_at: "2099-10-24T08:00:00.000Z",
          processed_at: null,
        },
      ],
      rowCount: 1,
    }));
    const store = new PostgresInboundMessageStore({ query } satisfies SqlClient);

    await expect(store.get("42", MESSAGE.wamid)).resolves.toMatchObject({
      reply_target_ciphertext: null,
    });
  });

  it("rejects an expiry that is not after receipt", async () => {
    const store = new InMemoryInboundMessageStore();
    await expect(
      store.save({
        ...record(),
        expires_at: "2026-09-23T08:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(InboundMessageStoreError);
  });
});
