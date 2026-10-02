/**
 * The one path a browser turn takes into the real agent.
 *
 * Nothing here fabricates a reply. Every agent line in the transcript is a
 * message the real `WhatsAppSender` actually handed to the in-memory
 * transport, and every "the agent did not answer" note is derived from an
 * observed ingress counter or a bounded wait that expired.
 */

import { post_signed_delivery, type FetchLike, type IngressCounts } from "./signed_delivery.js";
import { build_meta_button_payload, build_meta_text_payload } from "./meta_payload.js";
import { LocalChatOutboundRecorder, type RecordedReply } from "./outbound_recorder.js";
import {
  ChatInputError,
  type ChatTranscriptEntry,
  type LocalChatConversation,
  type TurnEvidence,
} from "./chat_conversation.js";

/** Longest wait for a worker reply before the tool reports it as unobserved. */
const DEFAULT_REPLY_TIMEOUT_MS = 8_000;

/** A turn submitted by the browser. */
export type ChatTurnInput =
  | { kind: "text"; text: string }
  | { kind: "button"; button_id: string };

/** Everything one submitted turn produced. */
export interface ChatTurnOutcome {
  evidence: TurnEvidence;
  replies: RecordedReply[];
  reply_error?: string;
}

/** Wiring for the turn gateway; holds the only copy of the app secret. */
export interface ChatTurnGatewayOptions {
  agent_base_url: string;
  webhook_path: string;
  phone_number_id: string;
  recorder: LocalChatOutboundRecorder;
  app_secret: string;
  fetch?: FetchLike;
  reply_timeout_ms?: number;
  now?: () => Date;
}

/** Sends one browser turn into the agent and records the real outcome. */
export class ChatTurnGateway {
  private readonly options: ChatTurnGatewayOptions;
  private readonly now: () => Date;

  /**
   * Create a gateway bound to one running agent.
   *
   * @param options - Target, credential, recorder, and bounded timeouts.
   */
  constructor(options: ChatTurnGatewayOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Validate, sign, deliver, and record one browser turn.
   *
   * @param conversation - End-user conversation receiving the result.
   * @param input - Untrusted browser value.
   * @returns Observed evidence plus any reply the agent really sent.
   * @throws ChatInputError When the browser asks for something not on offer.
   */
  async submit(
    conversation: LocalChatConversation,
    input: ChatTurnInput,
  ): Promise<ChatTurnOutcome> {
    const turn = this.prepare(conversation, input);
    conversation.remember_signed_turn(turn.raw_body, turn.wamid, turn.label);
    return this.deliver(conversation, turn, "");
  }

  /**
   * Replay the last signed turn byte for byte, as a provider redelivery does.
   *
   * This is the only honest way to show the agent's dedupe: a new WAMID would
   * be a new conversation turn, and a re-signed body with a new id would prove
   * nothing about `(tenant, wamid)` dedupe.
   *
   * @param conversation - Conversation whose last turn is replayed.
   * @returns Observed evidence; a duplicate produces no reply.
   * @throws ChatInputError When no turn has been signed yet.
   */
  async redeliver_last(conversation: LocalChatConversation): Promise<ChatTurnOutcome> {
    const last = conversation.last_signed_turn();
    if (last === undefined) throw new ChatInputError("nothing-to-redeliver");
    return this.deliver(
      conversation,
      { raw_body: last.raw_body, wamid: last.wamid, label: last.label },
      "[redelivery] ",
    );
  }

  /**
   * Prove the real ingress rejects an unsigned or tampered delivery.
   *
   * This exists so the local tool can show the fail-closed path without
   * anybody having to trust that it works.
   *
   * @param conversation - Conversation to record the self-check on.
   * @param input - Untrusted browser value; it is signed, then tampered with.
   * @returns The observed status, which must not be 200.
   */
  async run_signature_self_check(
    conversation: LocalChatConversation,
    input: ChatTurnInput,
  ): Promise<ChatTurnOutcome> {
    const turn = this.prepare(conversation, input);
    let http_status: number;
    let error: string | undefined;
    try {
      const result = await post_signed_delivery(
        {
          agent_base_url: this.options.agent_base_url,
          webhook_path: this.options.webhook_path,
          app_secret: this.options.app_secret,
          ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
        },
        turn.raw_body,
        { enabled: true },
      );
      http_status = result.http_status;
      error = result.error;
    } catch (failure) {
      return this.record_unreachable(conversation, turn.label, failure);
    }
    const evidence = empty_evidence(http_status, turn.wamid, error);
    conversation.record_rejected_turn(turn.label, evidence);
    conversation.record_system_note(
      `Self-check: the agent answered ${http_status} to a deliberately invalid signature, so it never queued the message.`,
    );
    return { evidence, replies: [], ...(error === undefined ? {} : { reply_error: error }) };
  }

  /** One prepared turn: the exact bytes to send and how to label them. */
  private async deliver(
    conversation: LocalChatConversation,
    turn: { raw_body: string; wamid: string; label: string },
    marker: string,
  ): Promise<ChatTurnOutcome> {
    let result;
    try {
      result = await post_signed_delivery(
        {
          agent_base_url: this.options.agent_base_url,
          webhook_path: this.options.webhook_path,
          app_secret: this.options.app_secret,
          ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
        },
        turn.raw_body,
      );
    } catch (error) {
      return this.record_unreachable(conversation, turn.label, error);
    }
    return this.record_result(conversation, turn, result.http_status, result.ingress, result.error, marker);
  }

  private prepare(
    conversation: LocalChatConversation,
    input: ChatTurnInput,
  ): { raw_body: string; wamid: string; label: string } {
    const wamid = conversation.next_inbound_wamid();
    const timestamp_seconds = Math.floor(this.now().getTime() / 1_000);
    const shared = {
      phone_number_id: this.options.phone_number_id,
      wa_id: conversation.sender_wa_id(),
      wamid,
      timestamp_seconds,
    };
    if (input.kind === "text") {
      const body = conversation.require_text(input.text);
      return {
        raw_body: stringify(build_meta_text_payload({ ...shared, body })),
        wamid,
        label: body,
      };
    }
    const button_id = conversation.require_offered_button(input.button_id);
    const title = conversation.require_offered_label(button_id);
    return {
      raw_body: stringify(build_meta_button_payload({ ...shared, button_id, title })),
      wamid,
      label: `[${title}]`,
    };
  }

  private async record_result(
    conversation: LocalChatConversation,
    turn: { wamid: string; label: string },
    http_status: number,
    ingress: IngressCounts | undefined,
    error: string | undefined,
    marker = "",
  ): Promise<ChatTurnOutcome> {
    const evidence: TurnEvidence = {
      http_status,
      ...(error === undefined ? {} : { error }),
      wamid: turn.wamid,
      ...(ingress === undefined ? {} : { request_id: ingress.request_id }),
      received_count: ingress?.received_count ?? 0,
      enqueued_count: ingress?.enqueued_count ?? 0,
      duplicate_count: ingress?.duplicate_count ?? 0,
      unresolved_count: ingress?.unresolved_count ?? 0,
      provider_wamids: [],
    };
    const entry = conversation.record_end_user_turn(turn.label, evidence, marker);
    if (http_status !== 200) {
      conversation.record_system_note(
        `The agent answered ${http_status}${error === undefined ? "" : ` (${error})`}; nothing was queued.`,
      );
      return { evidence, replies: [], ...(error === undefined ? {} : { reply_error: error }) };
    }
    if (evidence.enqueued_count === 0) {
      conversation.record_system_note(
        `Ingress counted this as a redelivery (${evidence.duplicate_count} duplicate, ${evidence.unresolved_count} unresolved), so the agent sent no reply.`,
      );
      return { evidence, replies: [] };
    }
    return this.await_reply(conversation, evidence, entry);
  }

  private async await_reply(
    conversation: LocalChatConversation,
    evidence: TurnEvidence,
    entry: ChatTranscriptEntry,
  ): Promise<ChatTurnOutcome> {
    const timeout_ms = this.options.reply_timeout_ms ?? DEFAULT_REPLY_TIMEOUT_MS;
    const replies = await this.options.recorder.wait_for_replies(evidence.wamid, timeout_ms);
    if (replies.length === 0) {
      conversation.record_system_note(
        `The agent accepted the message but no reply was observed within ${timeout_ms} ms.`,
      );
      return { evidence, replies: [] };
    }
    const provider_wamids = replies.map((reply) => reply.provider_wamid);
    conversation.record_outbound_evidence(entry, provider_wamids);
    for (const reply of replies) conversation.record_agent_reply(reply.text, reply.buttons);
    return { evidence: { ...evidence, provider_wamids }, replies };
  }

  private record_unreachable(
    conversation: LocalChatConversation,
    label: string,
    error: unknown,
  ): ChatTurnOutcome {
    const evidence = empty_evidence(0, "unassigned", undefined, error);
    conversation.record_rejected_turn(label, evidence);
    conversation.record_system_note("The agent ingress could not be reached; nothing was signed or sent.");
    return { evidence, replies: [], reply_error: "agent-unreachable" };
  }
}

function empty_evidence(
  http_status: number,
  wamid: string,
  error?: string,
  cause?: unknown,
): TurnEvidence {
  void cause;
  return {
    http_status,
    ...(error === undefined ? {} : { error }),
    wamid,
    received_count: 0,
    enqueued_count: 0,
    duplicate_count: 0,
    unresolved_count: 0,
    provider_wamids: [],
  };
}

function stringify(payload: Record<string, unknown>): string {
  try {
    return JSON.stringify(payload);
  } catch (error) {
    throw new ChatInputError(error instanceof Error ? "payload-invalid" : "payload-invalid");
  }
}

export { ChatInputError };
