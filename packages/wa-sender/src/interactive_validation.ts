import { MAX_APPLICATION_BUTTON_LABEL_CHARS } from "./template_validation.js";
import type { InteractivePayload, OutboundButton, OutboundMessage } from "./types.js";
import { OutboundMessageValidationError } from "./validation_error.js";

/** Maximum text length accepted in an interactive body. */
export const MAX_INTERACTIVE_TEXT_CHARS = 4_096;

/** Common message fields shared by the interactive validator. */
export interface InteractiveMessageFields {
  to: string;
  idempotency_key?: string;
  inbound_wamid?: string;
  turn_id?: string;
  template_required?: boolean;
  requires_confirmation?: boolean;
  is_state_changing?: boolean;
}

/**
 * Validate an interactive reply-button message.
 *
 * @param value - Untrusted message object.
 * @param common - Already validated routing and policy fields.
 * @returns An allow-listed interactive message without a policy decision.
 * @throws OutboundMessageValidationError for malformed interactive content.
 */
export function validate_interactive_message(
  value: Record<string, unknown>,
  common: InteractiveMessageFields,
): OutboundMessage {
  if (!is_record(value.interactive) || value.interactive.type !== "button") {
    throw new OutboundMessageValidationError("invalid_message");
  }
  const body = value.interactive.body;
  if (!is_record(body)) throw new OutboundMessageValidationError("invalid_message");
  const action = value.interactive.action;
  if (!is_record(action) || !Array.isArray(action.buttons) || action.buttons.length < 1 || action.buttons.length > 3) {
    throw new OutboundMessageValidationError("invalid_message");
  }
  const buttons = action.buttons.map(normalize_interactive_button);
  assert_unique_button_ids(buttons);
  const preview_url = optional_boolean(body.preview_url);
  const interactive: InteractivePayload = {
    type: "button",
    body: {
      text: require_text(body.text, MAX_INTERACTIVE_TEXT_CHARS),
      ...(preview_url === undefined ? {} : { preview_url }),
    },
    action: { buttons },
  };
  return {
    to: common.to,
    type: "interactive",
    interactive,
    ...optional_fields(common),
  };
}

/** Build the allow-listed Meta interactive object. */
export function build_interactive_payload(interactive: InteractivePayload): Record<string, unknown> {
  return {
    type: "button",
    body: {
      text: interactive.body.text,
      ...(interactive.body.preview_url === undefined ? {} : { preview_url: interactive.body.preview_url }),
    },
    action: {
      buttons: interactive.action.buttons.map((button) => ({
        type: "reply",
        reply: { id: button.button_id, title: button.label },
      })),
    },
  };
}

function normalize_interactive_button(value: unknown): OutboundButton {
  if (!is_record(value)) throw new OutboundMessageValidationError("invalid_message");
  const button_id = require_text(value.id ?? value.button_id, 256);
  const label = require_text(value.title ?? value.label, MAX_APPLICATION_BUTTON_LABEL_CHARS);
  if (value.type !== undefined && value.type !== "reply" && value.type !== "quick_reply") {
    throw new OutboundMessageValidationError("invalid_message");
  }
  return { button_id, label, type: "quick_reply", payload: button_id };
}

function assert_unique_button_ids(buttons: readonly OutboundButton[]): void {
  const ids = new Set<string>();
  for (const button of buttons) {
    if (ids.has(button.button_id)) throw new OutboundMessageValidationError("invalid_message");
    ids.add(button.button_id);
  }
}

function optional_fields(common: InteractiveMessageFields): Partial<OutboundMessage> {
  return {
    ...(common.idempotency_key === undefined ? {} : { idempotency_key: common.idempotency_key }),
    ...(common.inbound_wamid === undefined ? {} : { inbound_wamid: common.inbound_wamid }),
    ...(common.turn_id === undefined ? {} : { turn_id: common.turn_id }),
    ...(common.template_required === undefined ? {} : { template_required: common.template_required }),
    ...(common.requires_confirmation === undefined ? {} : { requires_confirmation: common.requires_confirmation }),
    ...(common.is_state_changing === undefined ? {} : { is_state_changing: common.is_state_changing }),
  };
}

function optional_boolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new OutboundMessageValidationError("invalid_message");
  return value;
}

function require_text(value: unknown, max_chars: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max_chars ||
    value.trim() === "" ||
    /[\u0000\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    throw new OutboundMessageValidationError("invalid_message");
  }
  return value;
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
