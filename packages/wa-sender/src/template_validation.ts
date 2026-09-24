import {
  contains_promotional_content,
  MAX_TEMPLATE_BUTTON_LABEL_CHARS,
  TemplateRegistry,
  validate_template_definition,
} from "./template_registry.js";
import type {
  OutboundButton,
  OutboundMessage,
  TemplateComponent,
  TemplateParameter,
  TemplatePayload,
} from "./types.js";
import { OutboundMessageValidationError } from "./validation_error.js";

/** Maximum number of parameters accepted in one template component. */
export const MAX_TEMPLATE_PARAMETERS = 20;

/** Maximum length of a quick-reply payload or stable button identifier. */
export const MAX_BUTTON_VALUE_CHARS = 256;

/** Maximum length of a user-visible application button label. */
export const MAX_APPLICATION_BUTTON_LABEL_CHARS = MAX_TEMPLATE_BUTTON_LABEL_CHARS;

const MAX_TEMPLATE_PARAMETER_TEXT_CHARS = 4_096;
const MAX_TEMPLATE_URL_CHARS = 2_048;
const MAX_TEMPLATE_BUTTON_INDEX = 1_000;

/** Normalize a template payload and its optional application buttons. */
export function normalize_template_message(
  template_value: unknown,
  buttons_value: unknown,
  registry: TemplateRegistry,
): { template: TemplatePayload; buttons?: readonly OutboundButton[] } {
  if (!is_record(template_value)) throw new OutboundMessageValidationError("invalid_message");
  if (!(registry instanceof TemplateRegistry)) throw new OutboundMessageValidationError("configuration_error");
  const name = require_template_name(template_value.name);
  let definition: ReturnType<TemplateRegistry["get"]>;
  try {
    definition = registry.get(name);
  } catch {
    throw new OutboundMessageValidationError("template_not_registered");
  }
  if (definition === undefined) throw new OutboundMessageValidationError("template_not_registered");
  try {
    validate_template_definition(definition);
  } catch {
    throw new OutboundMessageValidationError("template_not_registered");
  }
  const language = normalize_template_language(template_value.language);
  const components = normalize_template_components(template_value.components);
  const buttons = normalize_buttons(buttons_value, definition.button_label);
  return {
    template: { name, language, ...(components === undefined ? {} : { components }) },
    ...(buttons === undefined ? {} : { buttons }),
  };
}

/** Build the Meta component list, including application-level buttons. */
export function build_template_components(message: OutboundMessage): TemplateComponent[] {
  const components = [...(message.template?.components ?? [])];
  for (const button of message.buttons ?? []) {
    const index = components.filter((component) => component.type === "button").length;
    components.push({
      type: "button",
      sub_type: button.type ?? "quick_reply",
      index: String(index),
      parameters:
        button.type === "url"
          ? [{ type: "url", url: button.url as string }]
          : [{ type: "payload", payload: button.payload as string }],
    });
  }
  return components;
}

/** Convert the normalized language contract to Meta's object form. */
export function normalize_meta_language(language: TemplatePayload["language"]): { code: string } {
  return { code: typeof language === "string" ? language : language.code };
}

function normalize_template_components(value: unknown): readonly TemplateComponent[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_TEMPLATE_PARAMETERS) {
    throw new OutboundMessageValidationError("invalid_message");
  }
  return value.map((component) => normalize_component(component));
}

function normalize_component(value: unknown): TemplateComponent {
  if (!is_record(value) || (value.type !== "body" && value.type !== "button")) {
    throw new OutboundMessageValidationError("invalid_message");
  }
  const parameters = normalize_parameters(value.parameters);
  if (value.type === "body") {
    if (value.sub_type !== undefined || value.index !== undefined) {
      throw new OutboundMessageValidationError("invalid_message");
    }
    return { type: "body", ...(parameters === undefined ? {} : { parameters }) };
  }
  const sub_type = value.sub_type;
  if (sub_type !== "quick_reply" && sub_type !== "url") {
    throw new OutboundMessageValidationError("invalid_message");
  }
  const index = require_button_index(value.index);
  if (parameters === undefined || parameters.length !== 1) {
    throw new OutboundMessageValidationError("invalid_message");
  }
  return { type: "button", sub_type, index: String(index), parameters };
}

function normalize_parameters(value: unknown): readonly TemplateParameter[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_TEMPLATE_PARAMETERS) {
    throw new OutboundMessageValidationError("invalid_message");
  }
  return value.map((parameter) => {
    if (!is_record(parameter) || typeof parameter.type !== "string") {
      throw new OutboundMessageValidationError("invalid_message");
    }
    if (parameter.type === "text") {
      return { type: "text", text: require_text(parameter.text, MAX_TEMPLATE_PARAMETER_TEXT_CHARS) };
    }
    if (parameter.type === "payload") {
      return { type: "payload", payload: require_text(parameter.payload, MAX_BUTTON_VALUE_CHARS) };
    }
    if (parameter.type === "url") {
      return { type: "url", url: require_https_url(parameter.url) };
    }
    throw new OutboundMessageValidationError("invalid_message");
  });
}

function normalize_buttons(value: unknown, approved_label: string | undefined): readonly OutboundButton[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_TEMPLATE_PARAMETERS) {
    throw new OutboundMessageValidationError("invalid_message");
  }
  if (value.length > 0 && approved_label === undefined) {
    throw new OutboundMessageValidationError("invalid_message");
  }
  const buttons = value.map((button) => normalize_button(button));
  const ids = new Set<string>();
  for (const button of buttons) {
    if (ids.has(button.button_id)) throw new OutboundMessageValidationError("invalid_message");
    ids.add(button.button_id);
  }
  return buttons;
}

function normalize_button(value: unknown): OutboundButton {
  if (!is_record(value)) throw new OutboundMessageValidationError("invalid_message");
  const button_id = require_text(value.button_id, MAX_BUTTON_VALUE_CHARS);
  const label = require_text(value.label, MAX_APPLICATION_BUTTON_LABEL_CHARS);
  if (contains_promotional_content(label)) throw new OutboundMessageValidationError("invalid_message");
  const type = value.type ?? "quick_reply";
  if (type === "quick_reply") {
    if (value.url !== undefined) throw new OutboundMessageValidationError("invalid_message");
    return { button_id, label, type, payload: require_text(value.payload, MAX_BUTTON_VALUE_CHARS) };
  }
  if (type === "url" && value.payload === undefined) {
    return { button_id, label, type, url: require_https_url(value.url) };
  }
  throw new OutboundMessageValidationError("invalid_message");
}

function normalize_template_language(value: unknown): TemplatePayload["language"] {
  if (typeof value === "string") return require_language_code(value);
  if (!is_record(value)) throw new OutboundMessageValidationError("invalid_message");
  return { code: require_language_code(value.code) };
}

function require_language_code(value: unknown): string {
  if (typeof value !== "string" || value.length > 32 || !/^[A-Za-z]{2,3}(?:[-_][A-Za-z]{2,4})?$/u.test(value)) {
    throw new OutboundMessageValidationError("invalid_message");
  }
  return value;
}

function require_template_name(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || !/^[a-z0-9_]+$/u.test(value)) {
    throw new OutboundMessageValidationError("invalid_message");
  }
  return value;
}

function require_button_index(value: unknown): number {
  const normalized = typeof value === "number" ? String(value) : value;
  if (typeof normalized !== "string" || !/^(?:0|[1-9]\d*)$/u.test(normalized)) {
    throw new OutboundMessageValidationError("invalid_message");
  }
  const index = Number(normalized);
  if (!Number.isSafeInteger(index) || index > MAX_TEMPLATE_BUTTON_INDEX) {
    throw new OutboundMessageValidationError("invalid_message");
  }
  return index;
}

function require_https_url(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > MAX_TEMPLATE_URL_CHARS ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new OutboundMessageValidationError("invalid_message");
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") throw new Error("protocol");
    return value;
  } catch {
    throw new OutboundMessageValidationError("invalid_message");
  }
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
