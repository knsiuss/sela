/** Adapter from the worker's channel-neutral draft to @repo/wa-sender. */

import {
  WhatsAppSender,
  type OutboundButton,
  type OutboundMessage,
} from "@repo/wa-sender";
import type { OutboundSenderPort } from "../worker/loop.js";
import type { OutboundDraft } from "../worker/process_job.js";

/** Safe adapter failure for a draft shape the current sender cannot represent. */
export class OutboundDraftError extends Error {
  /** Stable machine-readable adapter failure code. */
  readonly code: string;

  /** Create a sanitized adapter error. */
  constructor(code: string) {
    super(`outbound-draft-invalid: ${code}`);
    this.name = "OutboundDraftError";
    this.code = code;
  }
}

/** Translate worker drafts into the sender package's allow-listed contract. */
export class WhatsAppSenderAdapter implements OutboundSenderPort {
  private readonly sender: WhatsAppSender;

  /**
   * Create an adapter around a configured sender.
   *
   * @param sender - Sender with an injected Meta or in-memory transport.
   */
  constructor(sender: WhatsAppSender) {
    this.sender = sender;
  }

  /**
   * Send one draft without logging its transient recipient.
   *
   * Buttons become Meta interactive reply buttons, which are valid for service
   * messages inside the customer-service window. A future state-changing draft
   * must carry both the state-changing marker and explicit customer consent.
   *
   * @param draft - Worker-produced outbound draft.
   * @returns Sender acknowledgement.
   * @throws OutboundDraftError for unsupported or unconfirmed state changes.
   */
  async send(draft: OutboundDraft): Promise<unknown> {
    if (draft.message_type === "template") {
      throw new OutboundDraftError("template-draft-not-configured");
    }
    if (draft.is_state_changing === true && draft.customer_confirmed !== true) {
      throw new OutboundDraftError("customer-confirmation-required");
    }
    const message = to_outbound_message(draft);
    const result = await this.sender.send(message, draft.is_state_changing === true
      ? { confirmation_policy: () => true }
      : undefined);
    if (is_record(result) && result.status === "failed") {
      throw new OutboundDraftError("provider-rejected");
    }
    return result;
  }
}

function to_outbound_message(draft: OutboundDraft): OutboundMessage {
  const buttons = (draft.buttons ?? []).map(to_outbound_button);
  const common = {
    to: draft.to,
    ...(draft.idempotency_key === undefined ? {} : { idempotency_key: draft.idempotency_key }),
    ...(draft.inbound_wamid === undefined ? {} : { inbound_wamid: draft.inbound_wamid }),
    ...(draft.turn_id === undefined ? {} : { turn_id: draft.turn_id }),
    ...(draft.is_state_changing === undefined ? {} : { is_state_changing: draft.is_state_changing }),
  };
  if (buttons.length > 0) {
    return {
      ...common,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: draft.text },
        action: { buttons },
      },
    };
  }
  return { ...common, type: "text", text: { body: draft.text } };
}

function to_outbound_button(button: NonNullable<OutboundDraft["buttons"]>[number]): OutboundButton {
  if (button === undefined) throw new OutboundDraftError("button-missing");
  return {
    button_id: button.id,
    label: button.label,
    type: "quick_reply",
    payload: button.payload ?? button.id,
  };
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
