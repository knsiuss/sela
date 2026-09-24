/** Fail-closed registry for the utility templates used by outbound WhatsApp. */

import type { TemplateCategory } from "./types.js";

/** Maximum number of characters allowed in a template button label. */
export const MAX_TEMPLATE_BUTTON_LABEL_CHARS = 20;

/** Promotional terms that force a template out of the utility category. */
export const PROMOTIONAL_TERMS = ["diskon", "free", "bonus", "promo"] as const;

/** Built-in template names supported by the appointment flow. */
export const UTILITY_TEMPLATE_NAMES = [
  "appointment_reminder",
  "confirm_prompt",
  "slot_offer",
  "reschedule_confirmed",
  "handoff_notice",
  "operator_reply",
] as const;

/** One registered utility template definition. */
export interface UtilityTemplateDefinition {
  /** Lowercase Meta template name. */
  name: string;
  /** Meta category; this registry accepts utility only. */
  category: TemplateCategory;
  /** Approved body copy without promotional language. */
  body: string;
  /** Optional user-visible button label. */
  button_label?: string;
  /** Default Meta language code. */
  language?: string;
}

/** Stable registration failures that do not echo template content. */
export type TemplateRegistrationErrorCode =
  | "invalid_template"
  | "wrong_category"
  | "promotional_content"
  | "button_label_too_long"
  | "duplicate_template"
  | "unknown_template";

/** Error raised when a template cannot be safely registered or resolved. */
export class TemplateRegistrationError extends Error {
  /** Machine-readable reason safe for logs and callers. */
  readonly code: TemplateRegistrationErrorCode;

  /**
   * Create a safe template registration error.
   *
   * @param code - Stable reason without template body or customer data.
   */
  constructor(code: TemplateRegistrationErrorCode) {
    super(`template-registration-failed: ${code}`);
    this.name = "TemplateRegistrationError";
    this.code = code;
  }
}

/**
 * Check whether text contains a promotional term.
 *
 * The check intentionally uses substring matching. A false positive causes a
 * safe registration rejection instead of risking a marketing reclassification.
 *
 * @param text - Template text to inspect.
 * @returns True when a prohibited promotional term is present.
 */
export function contains_promotional_content(text: string): boolean {
  if (typeof text !== "string") return true;
  const normalized = text.toLocaleLowerCase("en-US");
  return PROMOTIONAL_TERMS.some((term) => normalized.includes(term));
}

/**
 * Validate one template definition before it enters the registry.
 *
 * @param definition - Candidate template definition.
 * @returns Nothing when the definition is safe.
 * @throws TemplateRegistrationError when a utility-only invariant is violated.
 */
export function validate_template_definition(definition: UtilityTemplateDefinition): void {
  if (!is_record(definition) || typeof definition.name !== "string" || definition.name.trim() === "") {
    throw new TemplateRegistrationError("invalid_template");
  }
  if (typeof definition.body !== "string" || definition.body.trim() === "") {
    throw new TemplateRegistrationError("invalid_template");
  }
  if (definition.category !== "utility") {
    throw new TemplateRegistrationError("wrong_category");
  }
  if (contains_promotional_content(definition.body)) {
    throw new TemplateRegistrationError("promotional_content");
  }
  if (definition.button_label !== undefined) {
    if (typeof definition.button_label !== "string" || definition.button_label.length === 0) {
      throw new TemplateRegistrationError("invalid_template");
    }
    if (definition.button_label.length > MAX_TEMPLATE_BUTTON_LABEL_CHARS) {
      throw new TemplateRegistrationError("button_label_too_long");
    }
    if (contains_promotional_content(definition.button_label)) {
      throw new TemplateRegistrationError("promotional_content");
    }
  }
}

/** Built-in utility templates; bodies intentionally contain no promotion copy. */
export const BUILTIN_TEMPLATE_DEFINITIONS: readonly UtilityTemplateDefinition[] = Object.freeze([
  {
    name: "appointment_reminder",
    category: "utility",
    body: "Reminder: your appointment is scheduled for {{1}}.",
    button_label: "Confirm attendance",
    language: "en_US",
  },
  {
    name: "confirm_prompt",
    category: "utility",
    body: "Please confirm your appointment for {{1}} by choosing an option below.",
    button_label: "Confirm appointment",
    language: "en_US",
  },
  {
    name: "slot_offer",
    category: "utility",
    body: "Available appointment times: {{1}}. Please choose an option.",
    button_label: "Choose a time",
    language: "en_US",
  },
  {
    name: "reschedule_confirmed",
    category: "utility",
    body: "Your appointment has been rescheduled and confirmed for {{1}}.",
    button_label: "Need operator",
    language: "en_US",
  },
  {
    name: "handoff_notice",
    category: "utility",
    body: "Your request is being transferred to our team. They will continue shortly.",
    button_label: "Talk to operator",
    language: "en_US",
  },
  {
    name: "operator_reply",
    category: "utility",
    body: "An operator is ready to help with your request.",
    button_label: "Continue",
    language: "en_US",
  },
]);

/** In-memory registry with immutable copies exposed to callers. */
export class TemplateRegistry {
  private readonly definitions = new Map<string, UtilityTemplateDefinition>();

  /**
   * Create a registry and register its definitions.
   *
   * @param definitions - Initial definitions; defaults to the built-ins.
   * @throws TemplateRegistrationError when any definition is unsafe.
   */
  constructor(definitions: readonly UtilityTemplateDefinition[] = BUILTIN_TEMPLATE_DEFINITIONS) {
    for (const definition of definitions) this.register(definition);
  }

  /**
   * Register one utility template.
   *
   * @param definition - Candidate utility template.
   * @returns A defensive copy stored in the registry.
   * @throws TemplateRegistrationError for unsafe or conflicting definitions.
   */
  register(definition: UtilityTemplateDefinition): UtilityTemplateDefinition {
    validate_template_definition(definition);
    const existing = this.definitions.get(definition.name);
    if (existing !== undefined) {
      if (JSON.stringify(existing) === JSON.stringify(definition)) return { ...existing };
      throw new TemplateRegistrationError("duplicate_template");
    }
    const stored = Object.freeze({ ...definition });
    this.definitions.set(stored.name, stored);
    return { ...stored };
  }

  /**
   * Look up a template without exposing the registry's mutable map.
   *
   * @param name - Template name.
   * @returns A defensive copy, or undefined when the name is unknown.
   */
  get(name: string): UtilityTemplateDefinition | undefined {
    const definition = this.definitions.get(name);
    return definition === undefined ? undefined : { ...definition };
  }

  /**
   * Resolve a template or fail closed.
   *
   * @param name - Template name.
   * @returns A defensive template copy.
   * @throws TemplateRegistrationError when the name is unknown.
   */
  require(name: string): UtilityTemplateDefinition {
    const definition = this.get(name);
    if (definition === undefined) throw new TemplateRegistrationError("unknown_template");
    return definition;
  }

  /**
   * List registered definitions in registration order.
   *
   * @returns Defensive copies of all registered templates.
   */
  list(): UtilityTemplateDefinition[] {
    return [...this.definitions.values()].map((definition) => ({ ...definition }));
  }
}

/** Process-wide registry used by the default sender. */
export const template_registry = new TemplateRegistry();

/**
 * Register a template in the supplied registry.
 *
 * @param definition - Utility template to register.
 * @param registry - Target registry; defaults to the process registry.
 * @returns A defensive copy of the stored definition.
 */
export function register_template(
  definition: UtilityTemplateDefinition,
  registry: TemplateRegistry = template_registry,
): UtilityTemplateDefinition {
  return registry.register(definition);
}

/**
 * Find a template in the supplied registry.
 *
 * @param name - Template name.
 * @param registry - Registry to query.
 * @returns A defensive definition or undefined.
 */
export function get_template(
  name: string,
  registry: TemplateRegistry = template_registry,
): UtilityTemplateDefinition | undefined {
  return registry.get(name);
}

/**
 * List templates in the supplied registry.
 *
 * @param registry - Registry to query.
 * @returns Defensive definitions in registration order.
 */
export function list_templates(registry: TemplateRegistry = template_registry): UtilityTemplateDefinition[] {
  return registry.list();
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
