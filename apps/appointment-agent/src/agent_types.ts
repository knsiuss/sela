import { z } from "zod";

/** Maximum quick-reply buttons per WhatsApp message; actions stay deterministic. */
export const MAX_BUTTONS_PER_MESSAGE = 3;

/** Maximum characters per button label so labels render on small screens. */
export const MAX_BUTTON_LABEL_CHARS = 20;

/** Maximum inbound text characters accepted per turn (matches WhatsApp text limit). */
export const MAX_FREE_TEXT_CHARS = 4096;

/** Customer service window after the last user message (Meta 24-hour window). */
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Local-first LLM endpoint (Ollama OpenAI-compatible server, no per-token billing). */
export const DEFAULT_LLM_BASE_URL = "http://localhost:11434/v1";

/** Placeholder key for the local LLM server, which needs no real credential. */
export const DUMMY_LLM_API_KEY = "ollama-local-dummy";

/** Default local model tag; operators override it per deployment. */
export const DEFAULT_LLM_MODEL = "llama3.1";

export const request_id_schema = z.string().min(1).max(128);

export const conversation_id_schema = z.string().min(1).max(128);

/** Message categories that drive Meta per-message pricing. */
export const template_category_schema = z.enum(["marketing", "utility", "authentication"]);

export type TemplateCategory = z.infer<typeof template_category_schema>;

/** Deterministic quick-reply button; labels stay verb-first by convention. */
export const quick_reply_button_schema = z.object({
  button_id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_]+$/, "button_id must be lowercase snake_case"),
  label: z.string().min(1).max(MAX_BUTTON_LABEL_CHARS),
});

export type QuickReplyButton = z.infer<typeof quick_reply_button_schema>;

/** At least one and at most three buttons per message (Meta quick-reply cap). */
export const button_set_schema = z.array(quick_reply_button_schema).min(1).max(MAX_BUTTONS_PER_MESSAGE);

/** Single inbound webhook message after signature and channel parsing. */
export const inbound_message_schema = z.object({
  wamid: z.string().min(1).max(128),
  sender_phone_e164: z.string().regex(/^\+[1-9]\d{7,14}$/, "sender must be E.164"),
  text_body: z.string().min(1).max(MAX_FREE_TEXT_CHARS),
  message_kind: z.enum(["text", "button_reply"]),
  button_id: z.string().min(1).max(64).optional(),
  sent_at_iso: z.string().min(1),
});

export type InboundMessage = z.infer<typeof inbound_message_schema>;

/** Retained worker message; it carries an opaque sender reference, not a phone. */
export const retained_inbound_message_schema = z.object({
  wamid: z.string().min(1).max(128),
  sender_ref: z.string().min(1).max(256),
  text_body: z.string().min(1).max(MAX_FREE_TEXT_CHARS),
  message_kind: z.enum(["text", "button_reply"]),
  button_id: z.string().min(1).max(64).optional(),
  sent_at_iso: z.string().min(1),
});

export type RetainedInboundMessage = z.infer<typeof retained_inbound_message_schema>;

/** Booking hold lifecycle: free -> held -> confirmed, with expiry as the only exit from held. */
export const confirm_state_schema = z.enum(["free", "held", "confirmed", "expired"]);

export type ConfirmState = z.infer<typeof confirm_state_schema>;

/** Deny-list escalation reasons; thresholds never override these. */
export const handoff_reason_schema = z.enum(["emergency", "billing", "explicit_human", "operator_keyword"]);

export type HandoffReason = z.infer<typeof handoff_reason_schema>;

/** One redacted turn inside a handoff transcript package. */
export const transcript_entry_schema = z.object({
  at_iso: z.string().min(1),
  from: z.enum(["user", "agent", "staff"]),
  text_body: z.string().max(MAX_FREE_TEXT_CHARS),
});

export type TranscriptEntry = z.infer<typeof transcript_entry_schema>;

/** Context bundle handed to staff so the user never repeats themselves. */
export const handoff_package_schema = z.object({
  conversation_id: conversation_id_schema,
  reason: handoff_reason_schema,
  transcript: z.array(transcript_entry_schema).max(20),
  summary: z.string().max(2000).optional(),
  created_at_iso: z.string().min(1),
  request_id: request_id_schema,
});

export type HandoffPackage = z.infer<typeof handoff_package_schema>;

/** Audit event names; the log carries ids only, never message text or phone numbers. */
export const audit_event_name_schema = z.enum([
  "webhook_enqueued",
  "webhook_duplicate",
  "hold_created",
  "hold_confirmed",
  "hold_expired",
  "hold_released",
  "handoff_triggered",
]);

export type AuditEventName = z.infer<typeof audit_event_name_schema>;

/** Single audit record; PII-free by construction (no text body, no phone). */
export const audit_event_schema = z.object({
  request_id: request_id_schema,
  conversation_id: conversation_id_schema,
  event: audit_event_name_schema,
  wamid: z.string().min(1).max(128).optional(),
  created_at_iso: z.string().min(1),
});

export type AuditEvent = z.infer<typeof audit_event_schema>;

/** Local-first model configuration resolved from the environment. */
export const llm_config_schema = z.object({
  base_url: z.string().min(1),
  api_key: z.string().min(1),
  model: z.string().min(1),
});

export type LlmConfig = z.infer<typeof llm_config_schema>;

/**
 * Create a PII-free audit record for one turn or transition.
 *
 * Args:
 *   input: Request id, conversation id, event name, and optional message id.
 *
 * Returns:
 *   A validated audit event stamped with the current time.
 */
export function create_audit_event(input: {
  request_id: string;
  conversation_id: string;
  event: AuditEventName;
  wamid?: string;
}): AuditEvent {
  return audit_event_schema.parse({
    request_id: input.request_id,
    conversation_id: input.conversation_id,
    event: input.event,
    wamid: input.wamid,
    created_at_iso: new Date().toISOString(),
  });
}

/**
 * Check whether the 24-hour customer service window is still open.
 *
 * Inside the window the agent may send free-form replies; outside it only
 * approved templates are allowed.
 *
 * Args:
 *   last_user_message_at_ms: Epoch millis of the last inbound user message.
 *   now_ms: Epoch millis to compare against; defaults to the current time.
 *
 * Returns:
 *   True when the elapsed time is within the service window.
 */
export function is_service_window_open(last_user_message_at_ms: number, now_ms: number = Date.now()): boolean {
  return now_ms - last_user_message_at_ms <= SERVICE_WINDOW_MS;
}

/**
 * Resolve the local-first model configuration from the environment.
 *
 * The dummy key is a placeholder for the credential-free local server,
 * never a real secret; production deployments override all three values.
 *
 * Args:
 *   env: Environment mapping; defaults to the process environment.
 *
 * Returns:
 *   A validated model configuration pointing at the local server by default.
 */
export function resolve_llm_config(env: Record<string, string | undefined> = process.env): LlmConfig {
  return llm_config_schema.parse({
    base_url: env["LLM_BASE_URL"] ?? DEFAULT_LLM_BASE_URL,
    api_key: env["LLM_API_KEY"] ?? DUMMY_LLM_API_KEY,
    model: env["LLM_MODEL"] ?? DEFAULT_LLM_MODEL,
  });
}
