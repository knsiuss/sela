/** Process one claimed webhook job into local outbound drafts. */

import {
  retained_inbound_message_schema,
  SERVICE_WINDOW_MS,
  type RetainedInboundMessage,
} from "../agent_types.js";
import { build_graph } from "../graph.js";
import type { AppointmentStateType } from "../state.js";
import { build_outbound_drafts } from "../outbound/reply_builder.js";
import type { CalendarPort } from "../tools/calendar.js";
import type { InboundMessageRecord } from "../ingress/inbound_store.js";
import type { RecipientCipher } from "../security/recipient_cipher.js";
import type { InboundLoader } from "./inbound_loader.js";
import type { ClaimedWebhookJob } from "./job_claim.js";
import type { JobLifecycleStore } from "./job_store.js";

/** Local draft contract intentionally independent of the outbound package. */
export interface OutboundDraft {
  /** Transient E.164 recipient; use only for sender handoff, never log or persist it. */
  to: string;
  message_type: "text" | "template";
  text: string;
  buttons?: OutboundDraftButton[];
  /** Stable key for one logical outbound operation. */
  idempotency_key?: string;
  /** Stable inbound WAMID used to derive the key. */
  inbound_wamid?: string;
  /** Turn ordinal for multiple drafts from one inbound message. */
  turn_id?: string;
  /** Marks a future outbound operation that changes provider state. */
  is_state_changing?: boolean;
  /** Explicit customer confirmation gate for a state-changing operation. */
  customer_confirmed?: boolean;
}

/** Deterministic local action attached to an outbound draft. */
export interface OutboundDraftButton {
  id: string;
  label: string;
  payload?: string;
}

/** Injectable graph port used by tests and production composition. */
export interface GraphRunner {
  /**
   * Invoke the appointment graph.
   *
   * @param state - Initial tenant-scoped conversation state.
   * @returns Final graph state.
   */
  invoke(state: AppointmentStateType): Promise<AppointmentStateType>;
}

/** A sanitized processing failure with retry classification. */
export class JobProcessingError extends Error {
  /** Stable sanitized failure code. */
  readonly code: string;
  /** Whether the job should count as skipped rather than failed. */
  readonly is_skipped: boolean;

  /** Create a safe processor error. */
  constructor(code: string, is_skipped = false) {
    super(`job-processing-failed: ${code}`);
    this.name = "JobProcessingError";
    this.code = code;
    this.is_skipped = is_skipped;
  }
}

/** Dependencies for one job-processing call. */
export interface ProcessJobInput {
  job: ClaimedWebhookJob;
  inbound_loader: InboundLoader;
  recipient_cipher: RecipientCipher;
  calendar: CalendarPort;
  lifecycle: JobLifecycleStore;
  graph_runner?: GraphRunner;
  /** Delivers drafts before the inbound row and job are marked processed. */
  deliver?: (drafts: readonly OutboundDraft[]) => Promise<void>;
  max_attempts?: number;
  clock?: () => Date;
}

/**
 * Load, process, and complete one claimed job.
 *
 * The loader is always tenant-scoped. A missing, expired, or legacy row without
 * an encrypted reply target is a terminal skip. Graph failures are retried with
 * bounded exponential backoff; raw errors are reduced to stable codes before
 * persistence.
 *
 * @param input - Claimed job and injected processing boundaries.
 * @returns Drafts for an injected sender, after lifecycle state is completed.
 * @throws JobProcessingError after recording a sanitized failure.
 */
export async function process_job(input: ProcessJobInput): Promise<OutboundDraft[]> {
  const clock = input.clock ?? (() => new Date());
  const tenant_id = input.job.tenant_id;
  if (tenant_id === undefined) {
    await input.lifecycle.fail(input.job, "missing_tenant");
    throw new JobProcessingError("missing_tenant", true);
  }

  let record: InboundMessageRecord | null;
  try {
    record = await input.inbound_loader.load(tenant_id, input.job.wamid);
  } catch (error) {
    await fail_with_retry(input, sanitize_error_code(error));
    throw new JobProcessingError(sanitize_error_code(error));
  }
  if (record === null) {
    await input.lifecycle.fail(input.job, "missing_inbound_message");
    throw new JobProcessingError("missing_inbound_message", true);
  }
  if (record.tenant_id !== tenant_id || record.wamid !== input.job.wamid) {
    await input.lifecycle.fail(input.job, "inbound_message_scope_mismatch", undefined);
    throw new JobProcessingError("inbound_message_scope_mismatch", true);
  }
  const expires_ms = Date.parse(record.expires_at);
  if (!Number.isFinite(expires_ms)) {
    await input.lifecycle.fail(input.job, "invalid_inbound_expiry");
    throw new JobProcessingError("invalid_inbound_expiry", true);
  }
  if (expires_ms <= clock().getTime()) {
    await input.lifecycle.fail(input.job, "inbound_message_expired");
    throw new JobProcessingError("inbound_message_expired", true);
  }
  if (record.processed_at !== undefined && record.processed_at !== null) {
    await complete_or_retry(input);
    return [];
  }
  const received_ms = Date.parse(record.received_at);
  if (!Number.isFinite(received_ms)) {
    await input.lifecycle.fail(input.job, "invalid_inbound_received_at");
    throw new JobProcessingError("invalid_inbound_received_at", true);
  }
  if (clock().getTime() - received_ms > SERVICE_WINDOW_MS) {
    await input.lifecycle.fail(input.job, "service_window_expired");
    throw new JobProcessingError("service_window_expired", true);
  }
  if (record.reply_target_ciphertext === null) {
    await input.lifecycle.fail(input.job, "missing_reply_target");
    throw new JobProcessingError("missing_reply_target", true);
  }

  let reply_target: string;
  try {
    reply_target = input.recipient_cipher.decrypt(record.reply_target_ciphertext);
  } catch {
    await fail_with_retry(input, "reply_target_unavailable");
    throw new JobProcessingError("reply_target_unavailable");
  }

  try {
    const inbound_message = to_inbound_message(record);
    const graph = input.graph_runner ?? build_graph(input.calendar);
    const final_state = await graph.invoke(build_initial_state(input.job, inbound_message));
    const drafts = build_outbound_drafts(final_state, reply_target).map((draft, index) => ({
      ...draft,
      idempotency_key: `${input.job.wamid}:${index}`,
      inbound_wamid: input.job.wamid,
      turn_id: String(index),
    }));
    if (input.deliver !== undefined) await input.deliver(drafts);
    await mark_processed(input.inbound_loader, record, clock);
    await input.lifecycle.complete(input.job);
    return drafts;
  } catch (error) {
    const code = sanitize_error_code(error);
    await fail_with_retry(input, code);
    throw new JobProcessingError(code);
  }
}

async function complete_or_retry(input: ProcessJobInput): Promise<void> {
  try {
    await input.lifecycle.complete(input.job);
  } catch (error) {
    const code = sanitize_error_code(error);
    await fail_with_retry(input, code);
    throw new JobProcessingError(code);
  }
}

async function fail_with_retry(input: ProcessJobInput, code: string): Promise<void> {
  const max_attempts = positive_integer(input.max_attempts ?? 3, "max_attempts");
  const retry_at = input.job.attempts < max_attempts
    ? retry_time((input.clock ?? (() => new Date()))(), input.job.attempts)
    : undefined;
  await input.lifecycle.fail(input.job, code, retry_at);
}

async function mark_processed(
  loader: InboundLoader,
  record: InboundMessageRecord,
  clock: () => Date,
): Promise<void> {
  if (loader.mark_processed === undefined) {
    throw new JobProcessingError("inbound_processed_update_unavailable");
  }
  await loader.mark_processed(record.tenant_id, record.wamid, clock().toISOString());
}

function to_inbound_message(record: InboundMessageRecord): RetainedInboundMessage {
  const parsed = retained_inbound_message_schema.safeParse({
    wamid: record.wamid,
    sender_ref: record.sender_ref,
    text_body: record.message_text,
    message_kind: record.message_type === "button_reply" ? "button_reply" : "text",
    button_id: record.button_id ?? undefined,
    sent_at_iso: record.received_at,
  });
  if (!parsed.success) throw new JobProcessingError("invalid_inbound_message");
  return parsed.data;
}

function build_initial_state(job: ClaimedWebhookJob, message: RetainedInboundMessage): AppointmentStateType {
  return {
    conversation_id: job.conversation_id,
    raw_message: message.text_body,
    button_id: message.button_id,
    intent: "unknown",
    confidence: 0,
    candidate_slots: [],
    chosen_slot_id: undefined,
    hold: undefined,
    customer_confirmed: false,
    needs_human: false,
    human_summary: undefined,
    done: false,
  };
}

function retry_time(now: Date, attempts: number): Date {
  const exponent = Math.max(0, Math.min(attempts - 1, 10));
  return new Date(now.getTime() + 1_000 * 2 ** exponent);
}

function sanitize_error_code(error: unknown): string {
  if (error instanceof JobProcessingError) {
    return error.code;
  }
  if (is_record(error) && typeof error.code === "string") {
    const normalized = error.code.toLowerCase().replace(/[^a-z0-9_]+/g, "_");
    if (normalized.length > 0) return normalized.slice(0, 64);
  }
  if (error instanceof Error) {
    const normalized = error.name.toLowerCase().replace(/[^a-z0-9_]+/g, "_");
    if (normalized.length > 0) return normalized.slice(0, 64);
  }
  return "job_processing_failed";
}

function positive_integer(value: number, field_name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new JobProcessingError(`${field_name}_invalid`);
  return value;
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
