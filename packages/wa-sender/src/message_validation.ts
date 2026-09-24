import {
  build_interactive_payload,
  validate_interactive_message,
} from "./interactive_validation.js";
import {
  build_template_components,
  normalize_meta_language,
  normalize_template_message,
} from "./template_validation.js";
import { TemplateRegistry, template_registry } from "./template_registry.js";
import type { OutboundMessage } from "./types.js";
import {
  OutboundMessageValidationError,
  type ConfirmationPolicy,
  type OutboundValidationCode,
} from "./validation_error.js";

export {
  MAX_INTERACTIVE_TEXT_CHARS,
  build_interactive_payload,
  validate_interactive_message,
} from "./interactive_validation.js";
export {
  MAX_APPLICATION_BUTTON_LABEL_CHARS,
  MAX_BUTTON_VALUE_CHARS,
  MAX_TEMPLATE_PARAMETERS,
} from "./template_validation.js";
export {
  OutboundMessageValidationError,
  type ConfirmationPolicy,
  type OutboundValidationCode,
} from "./validation_error.js";

/** Maximum text length accepted at the WhatsApp boundary. */
export const MAX_WHATSAPP_TEXT_CHARS = 4_096;

/** Boundary options for message validation. */
export interface OutboundValidationOptions {
  /** Registry that supplies the fail-closed utility template policy. */
  template_registry?: TemplateRegistry;
  /** Force templates for this operation. */
  template_required?: boolean;
  /** Explicit policy for state-changing messages. */
  confirmation_policy?: ConfirmationPolicy;
  /** Internal/provider boundary switch; defaults to true for application sends. */
  enforce_policies?: boolean;
}

/**
 * Validate and normalize one outbound message.
 *
 * The function accepts untrusted input, returns an allow-listed copy, and never
 * logs or echoes recipient data. Template names must exist in the supplied
 * utility registry. A caller-required template and a state-changing policy are
 * checked after structural validation and before any side effect.
 *
 * @param value - Candidate message from an application or adapter.
 * @param options - Registry and policy settings.
 * @returns A normalized message safe to fingerprint and transport.
 * @throws OutboundMessageValidationError for every rejected boundary case.
 */
export function validate_outbound_message(
  value: unknown,
  options: OutboundValidationOptions = {},
): OutboundMessage {
  if (!is_record(value)) throw new OutboundMessageValidationError("invalid_message");
  const common = read_common_fields(value);
  const type = read_message_type(value.type);
  if (type === "text" && value.template !== undefined) {
    throw new OutboundMessageValidationError("invalid_message");
  }
  if (type === "template" && value.text !== undefined) {
    throw new OutboundMessageValidationError("invalid_message");
  }
  if (type === "interactive" && (value.text !== undefined || value.template !== undefined || value.buttons !== undefined)) {
    throw new OutboundMessageValidationError("invalid_message");
  }
  if (type === "text" && value.buttons !== undefined) {
    throw new OutboundMessageValidationError("invalid_message");
  }
  if ((options.enforce_policies ?? true) && (options.template_required ?? common.template_required ?? false) && type !== "template") {
    throw new OutboundMessageValidationError("template_required");
  }
  if (type === "text") return validate_text_message(value, common, options);
  if (type === "interactive") {
    const message = validate_interactive_message(value, common);
    enforce_confirmation_policy(message, options);
    return message;
  }
  return validate_template_message(value, common, options);
}

/**
 * Build the allow-listed Meta JSON payload for a message.
 *
 * @param message - Message returned by {@link validate_outbound_message}.
 * @param registry - Registry used to validate a template name.
 * @returns Meta Graph messages payload without application routing metadata.
 * @throws OutboundMessageValidationError if the message is structurally invalid.
 */
export function build_meta_payload(
  message: OutboundMessage,
  registry: TemplateRegistry = template_registry,
): Record<string, unknown> {
  if (!(registry instanceof TemplateRegistry)) throw new OutboundMessageValidationError("configuration_error");
  const validated = validate_outbound_message(message, {
    template_registry: registry,
    enforce_policies: false,
  });
  const base = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: validated.to,
    type: validated.type,
  };
  if (validated.type === "text") {
    if (validated.text === undefined) throw new OutboundMessageValidationError("invalid_message");
    return {
      ...base,
      text: { body: validated.text.body, ...(validated.text.preview_url === undefined ? {} : { preview_url: validated.text.preview_url }) },
    };
  }
  if (validated.type === "interactive") {
    if (validated.interactive === undefined) throw new OutboundMessageValidationError("invalid_message");
    return {
      ...base,
      interactive: build_interactive_payload(validated.interactive),
    };
  }
  if (validated.template === undefined) throw new OutboundMessageValidationError("invalid_message");
  const components = build_template_components(validated);
  return {
    ...base,
    template: {
      name: validated.template.name,
      language: normalize_meta_language(validated.template.language),
      ...(components.length === 0 ? {} : { components }),
    },
  };
}

interface CommonFields {
  to: string;
  idempotency_key?: string;
  inbound_wamid?: string;
  turn_id?: string;
  template_required?: boolean;
  requires_confirmation?: boolean;
  is_state_changing?: boolean;
}

function read_common_fields(value: Record<string, unknown>): CommonFields {
  return {
    to: require_recipient(value.to),
    idempotency_key: optional_string(value.idempotency_key),
    inbound_wamid: optional_string(value.inbound_wamid),
    turn_id: optional_string(value.turn_id),
    template_required: optional_boolean(value.template_required),
    requires_confirmation: optional_boolean(value.requires_confirmation),
    is_state_changing: optional_boolean(value.is_state_changing),
  };
}

function validate_text_message(
  value: Record<string, unknown>,
  common: CommonFields,
  options: OutboundValidationOptions,
): OutboundMessage {
  if (!is_record(value.text)) throw new OutboundMessageValidationError("invalid_message");
  const body = require_text(value.text.body, MAX_WHATSAPP_TEXT_CHARS);
  const preview_url = optional_boolean(value.text.preview_url);
  const message: OutboundMessage = {
    to: common.to,
    type: "text",
    text: { body, ...(preview_url === undefined ? {} : { preview_url }) },
    ...optional_fields(common),
  };
  enforce_confirmation_policy(message, options);
  return message;
}

function validate_template_message(
  value: Record<string, unknown>,
  common: CommonFields,
  options: OutboundValidationOptions,
): OutboundMessage {
  const registry = options.template_registry === undefined ? template_registry : options.template_registry;
  if (!(registry instanceof TemplateRegistry)) throw new OutboundMessageValidationError("configuration_error");
  const normalized = normalize_template_message(value.template, value.buttons, registry);
  const message: OutboundMessage = {
    to: common.to,
    type: "template",
    template: normalized.template,
    ...(normalized.buttons === undefined ? {} : { buttons: normalized.buttons }),
    ...optional_fields(common),
  };
  enforce_confirmation_policy(message, options);
  return message;
}

function enforce_confirmation_policy(message: OutboundMessage, options: OutboundValidationOptions): void {
  if (options.enforce_policies === false) return;
  if (message.is_state_changing !== true && message.requires_confirmation !== true) return;
  if (options.confirmation_policy === undefined || !policy_allows(options.confirmation_policy, message)) {
    throw new OutboundMessageValidationError("confirmation_required");
  }
}

function policy_allows(policy: ConfirmationPolicy, message: OutboundMessage): boolean {
  try {
    if (typeof policy === "function") return policy(message) === true;
    return policy.is_satisfied(message) === true;
  } catch {
    return false;
  }
}

function optional_fields(common: CommonFields): Partial<OutboundMessage> {
  return {
    ...(common.idempotency_key === undefined ? {} : { idempotency_key: common.idempotency_key }),
    ...(common.inbound_wamid === undefined ? {} : { inbound_wamid: common.inbound_wamid }),
    ...(common.turn_id === undefined ? {} : { turn_id: common.turn_id }),
    ...(common.template_required === undefined ? {} : { template_required: common.template_required }),
    ...(common.requires_confirmation === undefined ? {} : { requires_confirmation: common.requires_confirmation }),
    ...(common.is_state_changing === undefined ? {} : { is_state_changing: common.is_state_changing }),
  };
}

function require_recipient(value: unknown): string {
  if (typeof value !== "string" || !/^\+?[1-9]\d{6,14}$/u.test(value)) {
    throw new OutboundMessageValidationError("invalid_message");
  }
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

function optional_string(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new OutboundMessageValidationError("invalid_message");
  }
  return value;
}

function optional_boolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new OutboundMessageValidationError("invalid_message");
  return value;
}

function read_message_type(value: unknown): "text" | "template" | "interactive" {
  if (value === "text" || value === "template" || value === "interactive") return value;
  throw new OutboundMessageValidationError("invalid_message");
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
