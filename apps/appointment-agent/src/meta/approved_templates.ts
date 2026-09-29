/** Fail-closed configuration for approved Meta utility templates. */

/** Environment variable carrying the approved template list as JSON. */
export const APPROVED_TEMPLATES_ENV = "WHATSAPP_APPROVED_TEMPLATES_JSON";

/** Maximum approved templates kept in one deployment binding. */
export const MAX_APPROVED_TEMPLATES = 50;

/** Promotional terms that keep a template out of the utility category. */
const PROMOTIONAL_TERMS = ["promo", "free", "bonus", "diskon", "discount"] as const;

/** One approved non-promotional utility template binding. */
export interface ApprovedTemplateEntry {
  /** Lowercase Meta template name. */
  name: string;
  /** Meta language code such as en_US. */
  language: string;
  /** Only utility is accepted; marketing needs a separate approval path. */
  category: "utility";
  /** Optional Meta-side template identifier for operator records. */
  template_id?: string;
}

/** Stable reasons an approved-template binding is unusable. */
export type ApprovedTemplateConfigCode =
  | "templates_not_configured"
  | "templates_invalid"
  | "template_not_approved";

/** Fail-closed error when template configuration is missing or unsafe. */
export class ApprovedTemplateConfigError extends Error {
  /** Machine-readable reason safe for logs and callers. */
  readonly code: ApprovedTemplateConfigCode;

  /**
   * Create a sanitized template configuration error.
   *
   * @param code - Stable reason without template body or customer data.
   */
  constructor(code: ApprovedTemplateConfigCode) {
    super(`approved-template-unavailable: ${code}`);
    this.name = "ApprovedTemplateConfigError";
    this.code = code;
  }
}

/**
 * Parse and validate the approved utility-template binding.
 *
 * An absent, empty, or invalid binding throws: template sends must fail
 * closed until an operator records at least one approved non-promotional
 * utility template with a valid language.
 *
 * @param raw - Raw JSON value of WHATSAPP_APPROVED_TEMPLATES_JSON.
 * @returns Validated approved template entries in configured order.
 * @throws ApprovedTemplateConfigError when the binding is missing or unsafe.
 */
export function parse_approved_templates(raw: string | undefined): ApprovedTemplateEntry[] {
  if (raw === undefined || raw.trim() === "") {
    throw new ApprovedTemplateConfigError("templates_not_configured");
  }
  if (raw.length > 32_768) throw new ApprovedTemplateConfigError("templates_invalid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ApprovedTemplateConfigError("templates_invalid");
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_APPROVED_TEMPLATES) {
    throw new ApprovedTemplateConfigError("templates_invalid");
  }
  const seen = new Set<string>();
  return parsed.map((entry) => validate_entry(entry, seen));
}

/**
 * Resolve one approved template or fail closed.
 *
 * @param templates - Parsed approved template binding.
 * @param name - Template name requested by the caller.
 * @returns The approved entry for the name.
 * @throws ApprovedTemplateConfigError when the name is not approved.
 */
export function require_approved_template(
  templates: readonly ApprovedTemplateEntry[],
  name: string,
): ApprovedTemplateEntry {
  const found = templates.find((entry) => entry.name === name);
  if (found === undefined) throw new ApprovedTemplateConfigError("template_not_approved");
  return { ...found };
}

function validate_entry(value: unknown, seen: Set<string>): ApprovedTemplateEntry {
  if (!is_record(value)) throw new ApprovedTemplateConfigError("templates_invalid");
  const name = value["name"];
  const language = value["language"];
  const category = value["category"];
  if (typeof name !== "string" || !/^[a-z0-9_]{1,128}$/.test(name)) {
    throw new ApprovedTemplateConfigError("templates_invalid");
  }
  if (seen.has(name)) throw new ApprovedTemplateConfigError("templates_invalid");
  seen.add(name);
  if (typeof language !== "string" || !/^[a-z]{2}_[A-Z]{2}$/.test(language)) {
    throw new ApprovedTemplateConfigError("templates_invalid");
  }
  if (category !== "utility") throw new ApprovedTemplateConfigError("templates_invalid");
  if (contains_promotional_content(name)) throw new ApprovedTemplateConfigError("templates_invalid");
  const template_id = value["template_id"];
  if (template_id !== undefined && (typeof template_id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(template_id))) {
    throw new ApprovedTemplateConfigError("templates_invalid");
  }
  return template_id === undefined ? { name, language, category } : { name, language, category, template_id };
}

function contains_promotional_content(text: string): boolean {
  const normalized = text.toLowerCase();
  return PROMOTIONAL_TERMS.some((term) => normalized.includes(term));
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
