/**
 * Outbound observation for the local chat tool.
 *
 * The agent's `WHATSAPP_TRANSPORT=memory` path records every reply inside a
 * process-local transport, and the agent deliberately publishes no outbound
 * read surface: its audit events carry ids only. The public
 * `CompositionOptions.sender_registry` port is therefore the one non-invasive
 * place to observe what the real `WhatsAppSender` actually handed to the
 * transport, so this recorder decorates that port instead of adding an
 * endpoint to the ingress server.
 *
 * PII: `OutboundDraft.to` is the transient end-user recipient. It is dropped
 * before anything is retained, along with the derived idempotency key, so this
 * store can be printed or asserted on in a test transcript.
 */

import type { OutboundSenderRegistry } from "appointment-agent/dist/src/worker/loop.js";
import type { OutboundDraft } from "appointment-agent/dist/src/worker/process_job.js";

/** Largest number of replies retained; older entries are discarded. */
export const MAX_RECORDED_REPLIES = 200;

/** Reply wait cadence while the real worker polls its queue. */
const REPLY_POLL_INTERVAL_MS = 25;

/** One quick-reply action exactly as the agent rendered it. */
export interface RecordedReplyButton {
  id: string;
  label: string;
}

/** One real outbound message, stripped of every recipient-bound value. */
export interface RecordedReply {
  inbound_wamid: string;
  turn_id: string;
  message_type: "text" | "template";
  text: string;
  buttons: RecordedReplyButton[];
  provider_wamid: string;
  sent_at_iso: string;
}

/** Recording decorator around a real sender registry. */
export class LocalChatOutboundRecorder implements OutboundSenderRegistry {
  private readonly inner: OutboundSenderRegistry;
  private readonly clock: () => Date;
  private readonly replies: RecordedReply[] = [];
  private send_count = 0;

  /**
   * Wrap a resolved sender registry.
   *
   * @param inner - Registry built by the agent's own runtime sender resolution.
   * @param clock - Injectable clock so tests stay deterministic.
   */
  constructor(inner: OutboundSenderRegistry, clock: () => Date = () => new Date()) {
    this.inner = inner;
    this.clock = clock;
  }

  /**
   * Forward one draft unchanged and retain a recipient-free copy.
   *
   * Recording happens after the inner send resolves so an observed reply is
   * always one the transport actually accepted.
   *
   * @param tenant_id - Tenant carried by the claimed job.
   * @param draft - Draft the worker built for this turn.
   * @returns The inner sender's acknowledgement, untouched.
   */
  async send(tenant_id: string, draft: OutboundDraft): Promise<unknown> {
    const result = await this.inner.send(tenant_id, draft);
    this.record(draft, result);
    return result;
  }

  /**
   * Return every retained reply for one inbound WAMID, in send order.
   *
   * @param inbound_wamid - Stable inbound message id the worker replied to.
   * @returns Matching replies; empty when the turn produced none.
   */
  replies_for(inbound_wamid: string): RecordedReply[] {
    return this.replies
      .filter((reply) => reply.inbound_wamid === inbound_wamid)
      .map((reply) => copy_reply(reply));
  }

  /**
   * Wait until the worker delivers at least one reply for a WAMID.
   *
   * Returns an empty list on timeout rather than a placeholder: the tool must
   * never present a reply the agent did not actually send.
   *
   * @param inbound_wamid - Inbound message id to wait for.
   * @param timeout_ms - Upper bound on the wait.
   * @returns Delivered replies, or an empty list when none arrived in time.
   */
  async wait_for_replies(inbound_wamid: string, timeout_ms: number): Promise<RecordedReply[]> {
    const deadline_ms = this.clock().getTime() + Math.max(0, timeout_ms);
    for (;;) {
      const found = this.replies_for(inbound_wamid);
      if (found.length > 0) return found;
      if (this.clock().getTime() >= deadline_ms) return [];
      await delay(REPLY_POLL_INTERVAL_MS);
    }
  }

  /**
   * Report how many outbound sends passed through the real sender.
   *
   * @returns Total accepted sends since process start.
   */
  total_sent(): number {
    return this.send_count;
  }

  private record(draft: OutboundDraft, result: unknown): void {
    this.send_count += 1;
    const inbound_wamid = draft.inbound_wamid ?? "";
    const turn_id = draft.turn_id ?? "0";
    this.replies.push({
      inbound_wamid,
      turn_id,
      message_type: draft.message_type,
      text: draft.text,
      buttons: (draft.buttons ?? []).map((button) => ({ id: button.id, label: button.label })),
      provider_wamid: provider_wamid(result),
      sent_at_iso: this.clock().toISOString(),
    });
    if (this.replies.length > MAX_RECORDED_REPLIES) this.replies.shift();
  }
}

function provider_wamid(result: unknown): string {
  if (typeof result !== "object" || result === null) return "";
  const value = (result as { wamid?: unknown }).wamid;
  return typeof value === "string" ? value : "";
}

function copy_reply(reply: RecordedReply): RecordedReply {
  return { ...reply, buttons: reply.buttons.map((button) => ({ ...button })) };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
