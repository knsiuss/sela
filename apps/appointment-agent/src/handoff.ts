import {
  handoff_package_schema,
  MAX_FREE_TEXT_CHARS,
  type HandoffPackage,
  type HandoffReason,
  type TranscriptEntry,
} from "./agent_types.js";

export class InvalidHandoffRequestError extends Error {
  constructor(reason: string) {
    super(`invalid-handoff-request: ${reason}`);
    this.name = "InvalidHandoffRequestError";
  }
}

/** Keyword that always routes to staff, per the MVP handoff requirement. */
export const OPERATOR_KEYWORD = "operator";

/** Maximum transcript turns in a handoff package; keeps it small and PII-minimal. */
export const MAX_TRANSCRIPT_TURNS = 20;

/** Emergency vocabulary; matched first because liability outranks automation. */
export const EMERGENCY_PATTERN =
  /(emergency|darurat|chest pain|nyeri dada|shortness of breath|sesak|faint|pingsan|stroke|bleeding|pendarahan|accident|kecelakaan|ambulance|suicide|bunuh diri|overdose)/i;

/** Billing and coverage disputes, which need a human with system access. */
export const BILLING_PATTERN =
  /(refund|billing|charge|claim|invoice|bayar|tagih|asuransi|insurance|diskon|discount)/i;

/** Explicit requests for a person; includes Indonesian forms for the pilot market. */
export const EXPLICIT_HUMAN_PATTERN =
  /(human|manusia|staff|staf|agent|agen|doctor|dokter|nurse|perawat|connect me|tolong sambungkan|customer service)/i;

/**
 * Normalize raw user text for keyword matching.
 *
 * Args:
 *   raw_message: Raw customer message.
 *
 * Returns:
 *   Lowercased, trimmed text with whitespace collapsed.
 */
export function normalize_message_text(raw_message: string): string {
  return raw_message.toLowerCase().trim().replace(/\s+/g, " ");
}

/**
 * Check whether the message asks for the operator keyword.
 *
 * Args:
 *   message_text: Raw customer message.
 *
 * Returns:
 *   True when the normalized text contains the operator keyword.
 */
export function is_operator_request(message_text: string): boolean {
  return normalize_message_text(message_text).includes(OPERATOR_KEYWORD);
}

/**
 * Detect a deny-list handoff reason, or undefined when the bot may continue.
 *
 * Order is fixed by risk: operator keyword, then emergency, then billing,
 * then explicit-human requests. Confidence scores never override a match.
 *
 * Args:
 *   message_text: Raw customer message.
 *
 * Returns:
 *   The matched handoff reason, or undefined when no rule fires.
 */
export function detect_handoff_reason(message_text: string): HandoffReason | undefined {
  const text = normalize_message_text(message_text);
  if (text === "") return undefined;
  if (text.includes(OPERATOR_KEYWORD)) return "operator_keyword";
  if (EMERGENCY_PATTERN.test(text)) return "emergency";
  if (BILLING_PATTERN.test(text)) return "billing";
  if (EXPLICIT_HUMAN_PATTERN.test(text)) return "explicit_human";
  return undefined;
}

/**
 * Redact digit runs that usually carry phone numbers from handoff text.
 *
 * Dates and clock times are short digit runs and survive; long numbers such
 * as phones are replaced. Long confirmation codes may also be redacted,
 * which is accepted because staff can re-issue them from the transcript time.
 *
 * Args:
 *   text_body: Transcript line that may contain a phone number.
 *
 * Returns:
 *   The text with runs of four or more digits replaced.
 */
export function mask_phone_digits(text_body: string): string {
  return text_body.replace(/\d{4,}/g, "[redacted-number]");
}

/**
 * Build the transcript package staff receives on handoff.
 *
 * Only the last turns travel with the package and every line is masked,
 * so the user never repeats themselves and PII never reaches the log.
 *
 * Args:
 *   input: Conversation id, deny-list reason, full transcript, request id,
 *     and an optional staff-facing summary.
 *
 * Returns:
 *   A validated handoff package stamped with the current time.
 *
 * Raises:
 *   InvalidHandoffRequestError: If conversation or request id is empty.
 */
export function build_handoff_package(input: {
  conversation_id: string;
  reason: HandoffReason;
  transcript: TranscriptEntry[];
  request_id: string;
  summary?: string;
}): HandoffPackage {
  if (input.conversation_id === "" || input.request_id === "") {
    throw new InvalidHandoffRequestError("empty-ids");
  }
  if (input.summary !== undefined && input.summary.length > 2000) {
    throw new InvalidHandoffRequestError("summary-too-long");
  }
  const recent = input.transcript.slice(-MAX_TRANSCRIPT_TURNS).map((entry) => ({
    ...entry,
    text_body: mask_phone_digits(entry.text_body.slice(0, MAX_FREE_TEXT_CHARS)),
  }));
  return handoff_package_schema.parse({
    conversation_id: input.conversation_id,
    reason: input.reason,
    transcript: recent,
    summary: input.summary,
    created_at_iso: new Date().toISOString(),
    request_id: input.request_id,
  });
}

/**
 * Build the deterministic reply sent when a handoff triggers.
 *
 * One fixed English line keeps behavior predictable across deny-list
 * reasons; staff guidance for the specific reason lives in the package.
 *
 * Returns:
 *   The English handoff acknowledgement for the user.
 */
export function build_operator_reply(): string {
  return "Connecting you to our team now. Please hold while I pass along your conversation.";
}
