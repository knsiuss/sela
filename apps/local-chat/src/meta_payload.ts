/**
 * Genuine Meta Cloud API webhook payload construction.
 *
 * Every function here is pure and returns the exact bytes the chat tool signs
 * and sends. The shape mirrors what the agent's own `to_inbound_message`
 * accepts and matches Meta's documented webhook contract, so a payload that
 * survives `parse_inbound_messages` here will be accepted by the real ingress
 * and a rejected one is a genuine protocol mismatch rather than a silently
 * dropped message.
 *
 * PII: the end-user number is a reserved-for-fiction value that is only ever
 * used as a payload field. It is not logged and never reaches the browser.
 */

import { LOCAL_SYNTHETIC_PHONE_NUMBER_ID } from "./local_credentials.js";

/** Fields shared by both inbound message node variants. */
interface MetaMessageBase {
  phone_number_id: string;
  wa_id: string;
  wamid: string;
  timestamp_seconds: number;
}

/** Whitespace the agent's `text_body` schema rejects. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

/** Sanitized failure for a payload that cannot be built safely. */
export class MetaPayloadError extends Error {
  /** Create a safe payload failure. */
  constructor(reason: string) {
    super(`meta-payload-invalid: ${reason}`);
    this.name = "MetaPayloadError";
  }
}

/**
 * Build a Meta `messages` field notification carrying one text message.
 *
 * @param input - Channel id, synthetic sender, message id, body, and time.
 * @returns A JSON document ready to stringify, sign, and POST.
 * @throws MetaPayloadError When any bounded field is unusable.
 */
export function build_meta_text_payload(input: MetaMessageBase & { body: string }): Record<string, unknown> {
  const body = require_text(input.body);
  return wrap_message(input, { type: "text", text: { body } });
}

/**
 * Build a Meta notification carrying one interactive quick-reply answer.
 *
 * The agent reads the reply id from `interactive.button_reply.id` and the
 * visible label from `.title`, and requires a non-empty title because the
 * retained row stores it as the message text.
 *
 * @param input - Channel id, synthetic sender, message id, action, label, time.
 * @returns A JSON document ready to stringify, sign, and POST.
 * @throws MetaPayloadError When any bounded field is unusable.
 */
export function build_meta_button_payload(
  input: MetaMessageBase & { button_id: string; title: string },
): Record<string, unknown> {
  const button_id = require_action_id(input.button_id);
  const title = require_text(input.title);
  return wrap_message(input, {
    type: "interactive",
    interactive: { type: "button_reply", button_reply: { id: button_id, title } },
  });
}

/**
 * Mint the next inbound message id for this process.
 *
 * Meta WAMIDs are opaque strings, and the agent's dedupe key is the exact
 * `(tenant, wamid)` pair, so a stable local prefix plus a monotonic counter is
 * enough to make a redelivery reproducible on purpose.
 *
 * @param sequence - One-based turn counter.
 * @returns A unique WAMID within the agent's 128-character bound.
 */
export function next_wamid(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new MetaPayloadError("sequence-invalid");
  return `wamid.LOCAL.${String(sequence).padStart(6, "0")}`;
}

/**
 * Mint a synthetic end-user number for one conversation.
 *
 * The 555-01XX block is reserved for fiction, so a local transcript can never
 * contain a reachable subscriber number.
 *
 * @param sequence - One-based conversation counter.
 * @returns Digits-only `wa_id` that becomes E.164 once the agent adds `+`.
 * @throws MetaPayloadError When the value could not be a valid E.164 number.
 */
export function next_end_user_wa_id(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 9_999) {
    throw new MetaPayloadError("sequence-invalid");
  }
  const wa_id = `1555010${String(sequence).padStart(4, "0")}`;
  if (!/^[1-9]\d{7,14}$/u.test(wa_id)) throw new MetaPayloadError("end-user-number-invalid");
  return wa_id;
}

/**
 * Default channel id for payloads built by this tool.
 *
 * @returns The synthetic phone number id the local tenant resolver knows.
 */
export function local_phone_number_id(): string {
  return LOCAL_SYNTHETIC_PHONE_NUMBER_ID;
}

function wrap_message(input: MetaMessageBase, message: Record<string, unknown>): Record<string, unknown> {
  const wa_id = require_wa_id(input.wa_id);
  const phone_number_id = require_channel_id(input.phone_number_id);
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "LOCAL_WABA_ID",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "+15550000000", phone_number_id },
              // The channel account is written ONLY inside `metadata`, which is
              // where Meta's documented `messages`/`statuses` payloads carry it
              // and where the agent's tenant resolver reads it. A top-level
              // `phone_number_id` is not part of the provider contract: adding
              // one here made this harness mask a real ingress defect in which
              // every production delivery resolved no tenant while local runs
              // stayed green.
              contacts: [{ profile: { name: "Local end user" }, wa_id }],
              messages: [
                {
                  from: wa_id,
                  id: require_wamid(input.wamid),
                  timestamp: require_timestamp(input.timestamp_seconds),
                  ...message,
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function require_wa_id(value: string): string {
  if (typeof value !== "string" || !/^[1-9]\d{7,14}$/u.test(value)) {
    throw new MetaPayloadError("end-user-number-invalid");
  }
  return value;
}

function require_channel_id(value: string): string {
  if (typeof value !== "string" || !/^\d{6,20}$/u.test(value)) {
    throw new MetaPayloadError("channel-account-invalid");
  }
  return value;
}

function require_wamid(value: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 128) {
    throw new MetaPayloadError("wamid-invalid");
  }
  return value;
}

function require_timestamp(value: number): string {
  // The agent reads this as the inbound receipt time and skips a message that
  // is more than five minutes ahead or older than the service window, so a
  // fabricated timestamp would silently drop the turn.
  if (!Number.isInteger(value) || value < 0) throw new MetaPayloadError("timestamp-invalid");
  return String(value);
}

function require_text(value: string): string {
  if (typeof value !== "string") throw new MetaPayloadError("text-invalid");
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > 4_096) throw new MetaPayloadError("text-invalid");
  if (CONTROL_CHARACTERS.test(trimmed)) throw new MetaPayloadError("text-invalid");
  return trimmed;
}

function require_action_id(value: string): string {
  if (typeof value !== "string" || !/^[a-z0-9_]{1,64}$/u.test(value)) {
    throw new MetaPayloadError("button-id-invalid");
  }
  return value;
}
