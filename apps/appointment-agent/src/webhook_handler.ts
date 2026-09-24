import { createHash, randomUUID } from "node:crypto";
import { is_valid_signature, verify_challenge, type VerifyQuery } from "./ingress/verify.js";
import type { MessageDedupeStore } from "./ingress/dedupe.js";
import {
  create_audit_event,
  inbound_message_schema,
  type AuditEventName,
  type InboundMessage,
} from "./agent_types.js";

export class InvalidWebhookPayloadError extends Error {
  constructor(reason: string) {
    super(`invalid-webhook-payload: ${reason}`);
    this.name = "InvalidWebhookPayloadError";
  }
}

export class WebhookSignatureError extends Error {
  constructor() {
    super("webhook-signature-invalid");
    this.name = "WebhookSignatureError";
  }
}

export class WebhookQueueError extends Error {
  constructor(cause?: unknown) {
    super("webhook-enqueue-failed", cause === undefined ? undefined : { cause });
    this.name = "WebhookQueueError";
  }
}

/** Largest accepted webhook body; Meta payloads can reach 3 MB. */
export const MAX_WEBHOOK_BYTES = 3 * 1024 * 1024;

/** Single unit of deferred work produced from one inbound user message. */
export interface QueuedWebhookJob {
  request_id: string;
  wamid: string;
  conversation_id: string;
  received_at_iso: string;
}

/** Minimal queue contract; production binds this to the Postgres outbox. */
export interface WebhookJobQueue {
  enqueue(job: QueuedWebhookJob): Promise<void>;
}

/** Outcome counts for one inbound webhook delivery. */
export interface InboundHandleResult {
  request_id: string;
  received_count: number;
  duplicate_count: number;
  enqueued_count: number;
}

/** In-memory queue for tests and local dev. */
export class InMemoryWebhookQueue implements WebhookJobQueue {
  private jobs: QueuedWebhookJob[] = [];

  /**
   * Append a job to the tail of the queue.
   *
   * Args:
   *   job: Validated job carrying ids only, never message text or phones.
   */
  async enqueue(job: QueuedWebhookJob): Promise<void> {
    this.jobs.push(job);
  }

  /**
   * Return a copy of all queued jobs in arrival order.
   *
   * Returns:
   *   Snapshot of the queue contents.
   */
  pending_jobs(): QueuedWebhookJob[] {
    return [...this.jobs];
  }
}

/**
 * Generate a unique id that ties every log line of one delivery together.
 *
 * Returns:
 *   A random UUID string.
 */
export function generate_request_id(): string {
  return randomUUID();
}

/**
 * Derive a stable conversation key from the sender phone without storing it.
 *
 * The raw phone is PII, so the queue and logs only ever carry this hash;
 * the mapping back to a reply target lives in the worker layer.
 *
 * Args:
 *   sender_phone_e164: Sender phone in E.164 format.
 *
 * Returns:
 *   Hex SHA-256 digest of the phone number.
 */
export function derive_conversation_id(sender_phone_e164: string): string {
  return createHash("sha256").update(sender_phone_e164, "utf8").digest("hex");
}

/**
 * Validate a Meta verification (GET) request and return the challenge to echo.
 *
 * Args:
 *   query: Parsed hub.mode / hub.verify_token / hub.challenge fields.
 *   expected_token: Server-side verify token from the secret manager.
 *
 * Returns:
 *   The hub.challenge string to answer with HTTP 200.
 */
export function handle_verification_request(query: VerifyQuery, expected_token: string): string {
  return verify_challenge(query, expected_token);
}

/**
 * Write one PII-free audit line to structured logs.
 *
 * Args:
 *   input: Request id, hashed conversation id, event name, optional message id.
 */
export function log_audit_event(input: {
  request_id: string;
  conversation_id: string;
  event: AuditEventName;
  wamid?: string;
}): void {
  console.info(JSON.stringify(create_audit_event(input)));
}

/**
 * Collect candidate message nodes from a parsed Meta webhook payload.
 *
 * Args:
 *   payload: JSON-decoded webhook body of unknown shape.
 *
 * Returns:
 *   Raw message nodes; status updates and unknown shapes are skipped.
 */
function extract_raw_message_nodes(payload: unknown): unknown[] {
  if (typeof payload !== "object" || payload === null) return [];
  const entry = (payload as { entry?: unknown }).entry;
  if (!Array.isArray(entry)) return [];
  const nodes: unknown[] = [];
  for (const item of entry) {
    const changes = (item as { changes?: unknown }).changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const value = (change as { value?: unknown }).value;
      if (typeof value !== "object" || value === null) continue;
      const messages = (value as { messages?: unknown }).messages;
      if (Array.isArray(messages)) nodes.push(...messages);
    }
  }
  return nodes;
}

/**
 * Convert one raw Meta message node into a validated inbound message.
 *
 * Text, button, and interactive button-reply nodes become work; every other
 * node type (statuses, reactions, errors) returns undefined and is skipped.
 *
 * Args:
 *   node: Single raw message object from the webhook payload.
 *
 * Returns:
 *   A validated inbound message, or undefined when the node carries no work.
 *
 * Raises:
 *   InvalidWebhookPayloadError: If a user message node is malformed.
 */
function to_inbound_message(node: unknown): InboundMessage | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const record = node as Record<string, unknown>;
  const wamid = record["id"];
  const from = record["from"];
  if (typeof wamid !== "string" || typeof from !== "string") return undefined;
  const node_type = record["type"];
  let text_body: unknown;
  let message_kind: "text" | "button_reply" = "text";
  let button_id: string | undefined;
  if (node_type === "text") {
    text_body = (record["text"] as { body?: unknown } | undefined)?.body;
  } else if (node_type === "button") {
    const button = record["button"] as { payload?: unknown; text?: unknown } | undefined;
    button_id = typeof button?.payload === "string" ? button.payload : undefined;
    text_body = button?.text;
    message_kind = "button_reply";
  } else if (
    node_type === "interactive" &&
    (record["interactive"] as { type?: unknown } | undefined)?.type === "button_reply"
  ) {
    const reply = (record["interactive"] as { button_reply?: unknown }).button_reply as
      | { id?: unknown; title?: unknown }
      | undefined;
    button_id = typeof reply?.id === "string" ? reply.id : undefined;
    text_body = reply?.title;
    message_kind = "button_reply";
  } else {
    return undefined;
  }
  const timestamp = record["timestamp"];
  const sent_at_iso =
    typeof timestamp === "string" && Number.isFinite(Number(timestamp))
      ? new Date(Number(timestamp) * 1000).toISOString()
      : new Date().toISOString();
  const parsed = inbound_message_schema.safeParse({
    wamid,
    sender_phone_e164: from.startsWith("+") ? from : `+${from}`,
    text_body,
    message_kind,
    button_id,
    sent_at_iso,
  });
  if (!parsed.success) throw new InvalidWebhookPayloadError("malformed-message-node");
  return parsed.data;
}

/**
 * Parse a raw webhook body into validated inbound user messages.
 *
 * Args:
 *   raw_body: Exact raw request bytes as received, before any parsing.
 *
 * Returns:
 *   User messages ready for dedupe and enqueue; may be empty.
 *
 * Raises:
 *   InvalidWebhookPayloadError: If the body is oversized, not JSON, or malformed.
 */
export function parse_inbound_messages(raw_body: Buffer | string): InboundMessage[] {
  if (Buffer.byteLength(raw_body) > MAX_WEBHOOK_BYTES) {
    throw new InvalidWebhookPayloadError("payload-too-large");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw_body.toString("utf8"));
  } catch {
    throw new InvalidWebhookPayloadError("body-not-json");
  }
  if (typeof payload !== "object" || payload === null) {
    throw new InvalidWebhookPayloadError("body-not-object");
  }
  if ((payload as { object?: unknown }).object !== "whatsapp_business_account") {
    throw new InvalidWebhookPayloadError("unexpected-object");
  }
  const messages: InboundMessage[] = [];
  for (const node of extract_raw_message_nodes(payload)) {
    const message = to_inbound_message(node);
    if (message !== undefined) messages.push(message);
  }
  return messages;
}

/**
 * Verify, dedupe, and enqueue one inbound webhook delivery.
 *
 * Order is fixed: signature first (fail closed), then dedupe by stable
 * message id so Meta retries ACK 200 without reprocessing, then enqueue
 * for the worker. Every outcome is audit-logged without PII.
 *
 * Args:
 *   raw_body: Exact raw request bytes as received, before any parsing.
 *   signature_header: Value of the X-Hub-Signature-256 header.
 *   app_secret: Meta app secret from the secret manager.
 *   dedupe_store: Claim-once store keyed by stable message id.
 *   job_queue: Destination queue for deduplicated messages.
 *
 * Returns:
 *   Per-delivery outcome counts sharing one request id.
 *
 * Raises:
 *   WebhookSignatureError: If the signature is missing or mismatched.
 *   InvalidWebhookPayloadError: If the body cannot be parsed.
 *   WebhookQueueError: If a deduplicated message cannot be enqueued.
 */
export async function handle_inbound_request(
  raw_body: Buffer | string,
  signature_header: string | undefined,
  app_secret: string,
  dedupe_store: MessageDedupeStore,
  job_queue: WebhookJobQueue,
): Promise<InboundHandleResult> {
  if (!is_valid_signature(raw_body, signature_header, app_secret)) {
    throw new WebhookSignatureError();
  }
  const request_id = generate_request_id();
  const received_at_iso = new Date().toISOString();
  const messages = parse_inbound_messages(raw_body);
  let duplicate_count = 0;
  let enqueued_count = 0;
  for (const message of messages) {
    const conversation_id = derive_conversation_id(message.sender_phone_e164);
    const claimed = await dedupe_store.try_claim(message.wamid);
    if (!claimed) {
      duplicate_count += 1;
      log_audit_event({ request_id, conversation_id, event: "webhook_duplicate", wamid: message.wamid });
      continue;
    }
    try {
      await job_queue.enqueue({ request_id, wamid: message.wamid, conversation_id, received_at_iso });
    } catch (enqueue_error) {
      try {
        await dedupe_store.release_claim(message.wamid);
      } catch (release_error) {
        throw new WebhookQueueError(
          new AggregateError([enqueue_error, release_error], "webhook-claim-release-failed"),
        );
      }
      throw new WebhookQueueError(enqueue_error);
    }
    enqueued_count += 1;
    log_audit_event({ request_id, conversation_id, event: "webhook_enqueued", wamid: message.wamid });
  }
  return { request_id, received_count: messages.length, duplicate_count, enqueued_count };
}
