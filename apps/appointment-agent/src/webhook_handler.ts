import { createHash, randomUUID } from "node:crypto";
import { is_valid_signature, verify_challenge, type VerifyQuery } from "./ingress/verify.js";
import type { MessageDedupeStore } from "./ingress/dedupe.js";
import type { TenantResolver } from "./ingress/tenant_resolver.js";
import type { AtomicIngressStore } from "./ingress/postgres_atomic_ingress.js";
import {
  RecipientCipherError,
  type RecipientCipher,
} from "./security/recipient_cipher.js";
import {
  build_inbound_message_record,
  InboundMessageStoreError,
  type InboundMessageStore,
} from "./ingress/inbound_store.js";
import {
  create_audit_event,
  inbound_message_schema,
  type AuditEventName,
  type InboundMessage,
} from "./agent_types.js";

/** Invalid or unsupported webhook payload. */
export class InvalidWebhookPayloadError extends Error {
  /** Create a safe payload error. */
  constructor(reason: string) {
    super(`invalid-webhook-payload: ${reason}`);
    this.name = "InvalidWebhookPayloadError";
  }
}

/** Missing or invalid Meta signature. */
export class WebhookSignatureError extends Error {
  /** Create a signature error without echoing the supplied value. */
  constructor() {
    super("webhook-signature-invalid");
    this.name = "WebhookSignatureError";
  }
}

/** Queue persistence failed after ingress claimed a message. */
export class WebhookQueueError extends Error {
  /** Create a queue error while preserving the cause for internal handling. */
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
  /** Resolved tenant; required in production, optional for legacy local callers. */
  tenant_id?: string;
}

/** Minimal queue contract; production binds this to the Postgres outbox. */
export interface WebhookJobQueue {
  enqueue(job: QueuedWebhookJob): Promise<void>;
}

/** Optional tenant-aware ingress dependencies. */
export interface InboundRequestOptions {
  /** Resolves the Meta phone_number_id before any message is queued. */
  tenant_resolver?: TenantResolver;
  /** Retains the bounded inbound payload for the worker. */
  inbound_store?: InboundMessageStore;
  /** Encrypts the transient recipient before inbound-message persistence. */
  recipient_cipher?: RecipientCipher;
  /** Atomically claims, retains, and enqueues Postgres-backed messages. */
  atomic_ingress?: AtomicIngressStore;
  /** Cancels an in-flight atomic database transaction at the HTTP deadline. */
  signal?: AbortSignal;
  /** Overrides the default retention used when creating a record. */
  retention_days?: number;
}

/** Outcome counts for one inbound webhook delivery. */
export interface InboundHandleResult {
  request_id: string;
  received_count: number;
  duplicate_count: number;
  enqueued_count: number;
  unresolved_count: number;
}

/** In-memory queue for tests and local dev. */
export class InMemoryWebhookQueue implements WebhookJobQueue {
  private jobs: QueuedWebhookJob[] = [];
  private readonly claimed_indexes = new Set<number>();
  private next_job_number = 1;

  /**
   * Append a job to the tail of the queue.
   *
   * @param job - Validated job carrying ids and routing metadata.
   */
  async enqueue(job: QueuedWebhookJob): Promise<void> {
    this.jobs.push({ ...job });
  }

  /**
   * Return a copy of all queued jobs in arrival order.
   *
   * @returns Snapshot of the queue contents.
   */
  pending_jobs(): QueuedWebhookJob[] {
    return this.jobs.map((job) => ({ ...job }));
  }

  /**
   * Claim one in-memory job for the explicit local worker mode.
   *
   * @param tenant_id - Optional tenant filter.
   * @returns A claimed job or null.
   */
  async claim_next_job(tenant_id?: string): Promise<(QueuedWebhookJob & { id: string; attempts: number }) | null> {
    const index = this.jobs.findIndex(
      (job, job_index) => !this.claimed_indexes.has(job_index) && (tenant_id === undefined || job.tenant_id === tenant_id),
    );
    if (index < 0) return null;
    this.claimed_indexes.add(index);
    const job = this.jobs[index];
    if (job === undefined) return null;
    return {
      ...job,
      id: `inmemory-job-${this.next_job_number++}`,
      attempts: 1,
    };
  }
}

/**
 * Generate a unique id that ties every log line of one delivery together.
 *
 * @returns A random UUID string.
 */
export function generate_request_id(): string {
  return randomUUID();
}

/**
 * Derive a stable conversation key from the sender phone without storing it.
 *
 * @param sender_phone_e164 - Sender phone in E.164 format.
 * @returns Hex SHA-256 digest of the phone number.
 */
export function derive_conversation_id(sender_phone_e164: string): string {
  return createHash("sha256").update(sender_phone_e164, "utf8").digest("hex");
}

/**
 * Validate a Meta verification (GET) request and return the challenge to echo.
 *
 * @param query - Parsed hub.mode / hub.verify_token / hub.challenge fields.
 * @param expected_token - Server-side verify token from the secret manager.
 * @returns The hub.challenge string to answer with HTTP 200.
 */
export function handle_verification_request(query: VerifyQuery, expected_token: string): string {
  return verify_challenge(query, expected_token);
}

/**
 * Write one PII-free audit line to structured logs.
 *
 * @param input - Request id, hashed conversation id, event name, and message id.
 */
export function log_audit_event(input: {
  request_id: string;
  conversation_id: string;
  event: AuditEventName;
  wamid?: string;
}): void {
  console.info(JSON.stringify(create_audit_event(input)));
}

interface ParsedWebhookMessage {
  message: InboundMessage;
  channel_account_id: string;
}

function extract_raw_message_nodes(payload: unknown): ParsedWebhookMessage[] {
  if (!is_record(payload) || !Array.isArray(payload["entry"])) return [];
  const nodes: ParsedWebhookMessage[] = [];
  for (const item of payload["entry"]) {
    if (!is_record(item) || !Array.isArray(item["changes"])) continue;
    for (const change of item["changes"]) {
      if (!is_record(change) || !is_record(change["value"])) continue;
      const value = change["value"];
      const channel_account_id = value["phone_number_id"];
      const account_id = typeof channel_account_id === "string" ? channel_account_id : "";
      const messages = value["messages"];
      if (!Array.isArray(messages)) continue;
      for (const node of messages) {
        const message = to_inbound_message(node);
        if (message !== undefined) nodes.push({ message, channel_account_id: account_id });
      }
    }
  }
  return nodes;
}

/**
 * Convert one raw Meta message node into a validated inbound message.
 *
 * @param node - Single raw message object from the webhook payload.
 * @returns A validated inbound message, or undefined for non-user messages.
 * @throws InvalidWebhookPayloadError when a user message is malformed.
 */
function to_inbound_message(node: unknown): InboundMessage | undefined {
  if (!is_record(node)) return undefined;
  const wamid = node["id"];
  const from = node["from"];
  if (typeof wamid !== "string" || typeof from !== "string") return undefined;
  const node_type = node["type"];
  let text_body: unknown;
  let message_kind: "text" | "button_reply" = "text";
  let button_id: string | undefined;
  if (node_type === "text") {
    text_body = as_record(node["text"])?.["body"];
  } else if (node_type === "button") {
    const button = as_record(node["button"]);
    button_id = typeof button?.["payload"] === "string" ? button["payload"] : undefined;
    text_body = button?.["text"];
    message_kind = "button_reply";
  } else if (node_type === "interactive" && as_record(node["interactive"])?.["type"] === "button_reply") {
    const reply = as_record(as_record(node["interactive"])?.["button_reply"]);
    button_id = typeof reply?.["id"] === "string" ? reply["id"] : undefined;
    text_body = reply?.["title"];
    message_kind = "button_reply";
  } else {
    return undefined;
  }
  const timestamp = node["timestamp"];
  const sent_at_iso =
    typeof timestamp === "string" && Number.isFinite(Number(timestamp))
      ? new Date(Number(timestamp) * 1000).toISOString()
      : new Date().toISOString();
  const sender_phone_e164 = from.startsWith("+") ? from : `+${from}`;
  const parsed = inbound_message_schema.safeParse({
    wamid,
    sender_phone_e164,
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
 * @param raw_body - Exact raw request bytes as received.
 * @returns User messages ready for tenant resolution and enqueue.
 * @throws InvalidWebhookPayloadError when the body is invalid.
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
  if (!is_record(payload) || payload["object"] !== "whatsapp_business_account") {
    throw new InvalidWebhookPayloadError("unexpected-object");
  }
  return extract_raw_message_nodes(payload).map(({ message }) => message);
}

/**
 * Verify, tenant-resolve, retain, dedupe, and enqueue one webhook delivery.
 *
 * Signature validation is always first. A missing resolver or a resolver that
 * returns null skips that message; the delivery still returns 200. A configured
 * inbound store receives the row before the job is enqueued.
 *
 * @param raw_body - Exact raw request bytes.
 * @param signature_header - X-Hub-Signature-256 value.
 * @param app_secret - Meta app secret from the secret manager.
 * @param dedupe_store - Claim-once store keyed by stable message id.
 * @param job_queue - Durable destination queue.
 * @param options - Optional tenant resolver, inbound store, and retention.
 * @returns Per-delivery counts including unresolved channels.
 * @throws WebhookSignatureError, InvalidWebhookPayloadError, or persistence errors.
 */
export function handle_inbound_request(
  raw_body: Buffer | string,
  signature_header: string | undefined,
  app_secret: string,
  dedupe_store: MessageDedupeStore,
  job_queue: WebhookJobQueue,
  options?: InboundRequestOptions,
): Promise<InboundHandleResult>;
export function handle_inbound_request(
  raw_body: Buffer | string,
  signature_header: string | undefined,
  app_secret: string,
  dedupe_store: MessageDedupeStore,
  job_queue: WebhookJobQueue,
  tenant_resolver?: TenantResolver,
  inbound_store?: InboundMessageStore,
): Promise<InboundHandleResult>;
export async function handle_inbound_request(
  raw_body: Buffer | string,
  signature_header: string | undefined,
  app_secret: string,
  dedupe_store: MessageDedupeStore,
  job_queue: WebhookJobQueue,
  options_or_resolver?: InboundRequestOptions | TenantResolver,
  positional_inbound_store?: InboundMessageStore,
): Promise<InboundHandleResult> {
  const options = normalize_request_options(options_or_resolver, positional_inbound_store);
  if (!is_valid_signature(raw_body, signature_header, app_secret)) {
    throw new WebhookSignatureError();
  }
  const request_id = generate_request_id();
  const received_at_iso = new Date().toISOString();
  const messages = extract_raw_message_nodes(parse_payload(raw_body));
  const recipient_cipher = options.inbound_store === undefined
    ? options.recipient_cipher
    : require_recipient_cipher(options.recipient_cipher);
  let duplicate_count = 0;
  let enqueued_count = 0;
  let unresolved_count = 0;

  for (const { message, channel_account_id } of messages) {
    const tenant_id = await resolve_tenant(options.tenant_resolver, channel_account_id, options.signal);
    if (tenant_id === null || tenant_id === undefined) {
      unresolved_count += 1;
      continue;
    }

    const resolved_tenant_id = tenant_id;
    const conversation_id = derive_conversation_id(message.sender_phone_e164);
    const atomic_ingress = options.atomic_ingress;
    if (atomic_ingress !== undefined) {
      let result;
      try {
        result = await atomic_ingress.accept({
          tenant_id: resolved_tenant_id,
          request_id,
          received_at_iso,
          inbound_record: build_inbound_message_record({
            tenant_id: resolved_tenant_id,
            message,
            recipient_cipher: require_recipient_cipher(recipient_cipher),
            conversation_id,
            sender_ref: conversation_id,
            retention_days: options.retention_days,
            now: received_at_iso,
          }),
        }, options.signal);
      } catch (error) {
        throw new WebhookQueueError(error);
      }
      if (
        (result.status !== "accepted" && result.status !== "duplicate") ||
        result.tenant_id !== resolved_tenant_id ||
        result.wamid !== message.wamid
      ) {
        throw new WebhookQueueError(new Error("atomic-ingress-result-invalid"));
      }
      if (result.status === "duplicate") {
        duplicate_count += 1;
        log_audit_event({ request_id, conversation_id, event: "webhook_duplicate", wamid: message.wamid });
        continue;
      }
      enqueued_count += 1;
      log_audit_event({ request_id, conversation_id, event: "webhook_enqueued", wamid: message.wamid });
      continue;
    }

    const claimed = await dedupe_store.try_claim(resolved_tenant_id, message.wamid);
    if (!claimed) {
      duplicate_count += 1;
      log_audit_event({ request_id, conversation_id, event: "webhook_duplicate", wamid: message.wamid });
      continue;
    }

    try {
      if (options.inbound_store !== undefined) {
        await options.inbound_store.save(
          build_inbound_message_record({
            tenant_id: resolved_tenant_id,
            message,
            recipient_cipher: require_recipient_cipher(recipient_cipher),
            conversation_id,
            sender_ref: conversation_id,
            retention_days: options.retention_days,
            now: received_at_iso,
          }),
        );
      }
      await job_queue.enqueue({
        request_id,
        wamid: message.wamid,
        conversation_id,
        received_at_iso,
        tenant_id: resolved_tenant_id,
      });
    } catch (error) {
      await release_claim(dedupe_store, resolved_tenant_id, message.wamid, error);
      if (error instanceof InboundMessageStoreError || error instanceof RecipientCipherError) throw error;
      throw new WebhookQueueError(error);
    }
    enqueued_count += 1;
    log_audit_event({ request_id, conversation_id, event: "webhook_enqueued", wamid: message.wamid });
  }
  return {
    request_id,
    received_count: messages.length,
    duplicate_count,
    enqueued_count,
    unresolved_count,
  };
}

function require_recipient_cipher(cipher: RecipientCipher | undefined): RecipientCipher {
  if (cipher === undefined) throw new RecipientCipherError("recipient_cipher_unavailable");
  return cipher;
}

function normalize_request_options(
  options_or_resolver: InboundRequestOptions | TenantResolver | undefined,
  positional_inbound_store: InboundMessageStore | undefined,
): InboundRequestOptions {
  if (options_or_resolver === undefined) return { inbound_store: positional_inbound_store };
  if (is_record(options_or_resolver) && typeof options_or_resolver["resolve"] === "function") {
    return {
      tenant_resolver: options_or_resolver as unknown as TenantResolver,
      inbound_store: positional_inbound_store,
    };
  }
  return options_or_resolver as InboundRequestOptions;
}

async function resolve_tenant(
  resolver: TenantResolver | undefined,
  channel_account_id: string,
  signal?: AbortSignal,
): Promise<string | null | undefined> {
  if (resolver === undefined) return undefined;
  if (channel_account_id === "") return null;
  return resolver.resolve(channel_account_id, "whatsapp", signal);
}

async function release_claim(
  dedupe_store: MessageDedupeStore,
  tenant_id: string,
  wamid: string,
  original_error: unknown,
): Promise<void> {
  try {
    await dedupe_store.release_claim(tenant_id, wamid);
  } catch (release_error) {
    throw new WebhookQueueError(
      new AggregateError([original_error, release_error], "webhook-claim-release-failed"),
    );
  }
}

function parse_payload(raw_body: Buffer | string): Record<string, unknown> {
  if (Buffer.byteLength(raw_body) > MAX_WEBHOOK_BYTES) {
    throw new InvalidWebhookPayloadError("payload-too-large");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw_body.toString("utf8"));
  } catch {
    throw new InvalidWebhookPayloadError("body-not-json");
  }
  if (!is_record(payload) || payload["object"] !== "whatsapp_business_account") {
    throw new InvalidWebhookPayloadError("unexpected-object");
  }
  return payload;
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function as_record(value: unknown): Record<string, unknown> | undefined {
  return is_record(value) ? value : undefined;
}
