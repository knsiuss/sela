/**
 * Per-conversation state for the end-user persona.
 *
 * The browser may only ever *replay* an action the agent itself emitted. That
 * single rule is what keeps this client honest: it cannot invent a
 * `pick_slot_1_g7`, it cannot skip the offer, and it cannot smuggle a
 * generation-bound id from one conversation into another. Nothing the browser
 * sends widens what the agent will consider.
 *
 * PII: the synthetic end-user number stays here and is never projected out.
 * The agent's own conversation id is deliberately not retained at all — it is
 * a stable hash of that number, and this tool correlates on the agent's
 * request id instead.
 */

import { MAX_FREE_TEXT_CHARS } from "appointment-agent/dist/src/agent_types.js";
import { next_wamid } from "./meta_payload.js";

/**
 * Who produced a transcript line.
 *
 * `system` lines are written by this tool, never by the agent, and are only
 * ever used to report something the agent demonstrably did not do — a
 * rejected submission, an ignored redelivery, an unobserved reply.
 */
export type ChatRole = "end_user" | "agent" | "system";

/** One quick-reply action exactly as the agent rendered it. */
export interface ChatButtonView {
  id: string;
  label: string;
}

/** Observed ingress and delivery values for one submitted turn. */
export interface TurnEvidence {
  http_status: number;
  error?: string;
  wamid: string;
  request_id?: string;
  received_count: number;
  enqueued_count: number;
  duplicate_count: number;
  unresolved_count: number;
  provider_wamids: string[];
}

/** One line of the conversation as the browser sees it. */
export interface ChatTranscriptEntry {
  role: ChatRole;
  text: string;
  buttons: ChatButtonView[];
  at_iso: string;
  evidence?: TurnEvidence;
}

/** Everything the browser is allowed to see about a conversation. */
export interface PublicChatView {
  end_user_ref: string;
  entries: ChatTranscriptEntry[];
  tenant_id: string;
  role: string;
  webhook_path: string;
  /** Highest inbound WAMID ordinal minted for this conversation. */
  wamid_sequence: number;
}

/** Rejected browser input, before any signature or network work happens. */
export class ChatInputError extends Error {
  /** Create a safe input failure. */
  constructor(readonly code: string) {
    super(`chat-input-invalid: ${code}`);
    this.name = "ChatInputError";
  }
}

/** The only legal shape for an action id on the wire. */
const ACTION_ID_PATTERN = /^[a-z0-9_]{1,64}$/u;

/** One end-user conversation and the actions the agent has offered in it. */
export class LocalChatConversation {
  private readonly end_user_ref: string;
  private readonly wa_id: string;
  private readonly offered = new Map<string, string>();
  private readonly entries: ChatTranscriptEntry[] = [];
  private turn_sequence = 0;
  private agent_sequence = 0;
  private last_turn: { raw_body: string; wamid: string; label: string } | undefined;

  /**
   * Start a conversation for one synthetic end user.
   *
   * @param end_user_ref - Opaque persona label, never the number itself.
   * @param wa_id - Synthetic sender digits used only inside signed payloads.
   * @param now - Injectable clock so tests stay deterministic.
   */
  constructor(end_user_ref: string, wa_id: string, private readonly now: () => Date = () => new Date()) {
    this.end_user_ref = require_ref(end_user_ref);
    this.wa_id = require_wa_id(wa_id);
  }

  /**
   * Return the synthetic sender for this conversation.
   *
   * @returns Digits-only number placed in the signed payload.
   */
  sender_wa_id(): string {
    return this.wa_id;
  }

  /**
   * Mint the next inbound message id for this conversation.
   *
   * @returns A WAMID unique within this process.
   */
  next_inbound_wamid(): string {
    this.turn_sequence += 1;
    return next_wamid(this.turn_sequence);
  }

  /**
   * Normalise free text submitted by the browser.
   *
   * @param text - Untrusted browser value.
   * @returns The trimmed body that will be signed and sent.
   * @throws ChatInputError When the text is empty or over the WhatsApp limit.
   */
  require_text(text: unknown): string {
    if (typeof text !== "string") throw new ChatInputError("text-invalid");
    const trimmed = text.trim();
    if (trimmed === "") throw new ChatInputError("text-empty");
    if (trimmed.length > MAX_FREE_TEXT_CHARS) throw new ChatInputError("text-too-long");
    return trimmed;
  }

  /**
   * Accept an action id only when this agent offered it in this conversation.
   *
   * @param button_id - Untrusted browser value.
   * @throws ChatInputError When the id was never offered or is malformed.
   */
  require_offered_button(button_id: unknown): string {
    if (typeof button_id !== "string" || !ACTION_ID_PATTERN.test(button_id)) {
      throw new ChatInputError("button-id-invalid");
    }
    if (!this.offered.has(button_id)) throw new ChatInputError("button-not-offered");
    return button_id;
  }

  /**
   * Return the label the agent attached to an offered action.
   *
   * The agent requires a non-empty interactive reply title because the
   * retained inbound row stores it as the message text, so a replay must
   * carry the agent's own label rather than an invented one.
   *
   * @param button_id - Action id already accepted by `require_offered_button`.
   * @returns The label the agent emitted.
   * @throws ChatInputError When the label is missing or unusable.
   */
  require_offered_label(button_id: string): string {
    const label = this.offered.get(button_id);
    if (label === undefined || label.trim() === "") throw new ChatInputError("button-label-invalid");
    return label;
  }

  /**
   * Append the end-user's own line and the evidence for its delivery.
   *
   * @param text - Body the browser typed.
   * @param evidence - Observed ingress and delivery values.
   * @param marker - Optional label prefix, used to mark a redelivery.
   */
  record_end_user_turn(text: string, evidence: TurnEvidence, marker = ""): ChatTranscriptEntry {
    const entry: ChatTranscriptEntry = {
      role: "end_user",
      text: `${marker}${text}`,
      buttons: [],
      at_iso: this.now().toISOString(),
      evidence,
    };
    this.entries.push(entry);
    return entry;
  }

  /**
   * Attach the outbound ids observed for a turn already on the transcript.
   *
   * The end-user line is written as soon as ingress answers, but the provider
   * WAMID only exists after the worker delivers, so the evidence is completed
   * in place rather than by reordering the conversation.
   *
   * @param entry - Line returned by `record_end_user_turn`.
   * @param provider_wamids - Outbound ids the real sender accepted.
   */
  record_outbound_evidence(entry: ChatTranscriptEntry, provider_wamids: readonly string[]): void {
    if (entry.evidence === undefined) return;
    entry.evidence = { ...entry.evidence, provider_wamids: [...provider_wamids] };
  }

  /**
   * Remember the exact bytes of the last signed turn.
   *
   * A WhatsApp redelivery is the *same* payload arriving twice, so proving the
   * agent's dedupe needs byte-identical replay rather than a fresh message.
   * Only values already visible in the transcript are kept.
   *
   * @param raw_body - Exact bytes that were signed and sent.
   * @param wamid - Inbound message id carried by that body.
   * @param label - Human-readable rendering used when the turn is replayed.
   */
  remember_signed_turn(raw_body: string, wamid: string, label: string): void {
    this.last_turn = { raw_body, wamid, label };
  }

  /**
   * Return the last signed turn for verbatim redelivery.
   *
   * @returns A copy of the stored turn, or undefined before the first turn.
   */
  last_signed_turn(): { raw_body: string; wamid: string; label: string } | undefined {
    return this.last_turn === undefined ? undefined : { ...this.last_turn };
  }

  /**
   * Append the agent's real reply and remember its actions as offered.
   *
   * @param text - Reply body the sender actually accepted.
   * @param buttons - Quick replies the agent actually emitted.
   * @returns The appended entry.
   */
  record_agent_reply(text: string, buttons: readonly ChatButtonView[]): ChatTranscriptEntry {
    this.agent_sequence += 1;
    const entry: ChatTranscriptEntry = {
      role: "agent",
      text,
      buttons: buttons.map((button) => ({ ...button })),
      at_iso: this.now().toISOString(),
    };
    for (const button of buttons) this.offered.set(button.id, button.label);
    this.entries.push(entry);
    return entry;
  }

  /**
   * Append a note written by this tool about something the agent did not do.
   *
   * @param text - Plain statement of the observed outcome.
   */
  record_system_note(text: string): void {
    this.entries.push({
      role: "system",
      text,
      buttons: [],
      at_iso: this.now().toISOString(),
    });
  }

  /**
   * Record a rejected submission so the transcript shows what happened.
   *
   * @param text - What the browser tried to send, for the local view only.
   * @param evidence - Observed ingress values, including the failure status.
   */
  record_rejected_turn(text: string, evidence: TurnEvidence): void {
    this.entries.push({
      role: "end_user",
      text,
      buttons: [],
      at_iso: this.now().toISOString(),
      evidence,
    });
    this.record_system_note("The chat client rejected this input before signing anything.");
  }

  /**
   * Count how many agent replies this conversation has received.
   *
   * @returns Number of appended agent lines.
   */
  agent_reply_count(): number {
    return this.agent_sequence;
  }

  /**
   * Project the conversation for the browser.
   *
   * @returns A view with no credential, no number, and no agent-internal id.
   */
  to_public_view(base: { tenant_id: string; role: string; webhook_path: string }): PublicChatView {
    return {
      end_user_ref: this.end_user_ref,
      entries: this.entries.map((entry) => ({
        role: entry.role,
        text: entry.text,
        buttons: entry.buttons.map((button) => ({ ...button })),
        at_iso: entry.at_iso,
        ...(entry.evidence === undefined ? {} : { evidence: { ...entry.evidence } }),
      })),
      tenant_id: base.tenant_id,
      role: base.role,
      webhook_path: base.webhook_path,
      wamid_sequence: this.turn_sequence,
    };
  }
}

function require_ref(value: string): string {
  if (typeof value !== "string" || !/^[a-z0-9-]{1,64}$/u.test(value)) {
    throw new ChatInputError("end-user-ref-invalid");
  }
  return value;
}

function require_wa_id(value: string): string {
  if (typeof value !== "string" || !/^[1-9]\d{7,14}$/u.test(value)) {
    throw new ChatInputError("end-user-number-invalid");
  }
  return value;
}
