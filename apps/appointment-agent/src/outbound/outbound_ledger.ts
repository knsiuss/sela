/** PII-minimal durable outbound operation and delivery-state contracts. */

import { createHash, randomUUID } from "node:crypto";
import type { OutboundDraft } from "../worker/process_job.js";

/** Ledger lifecycle states. `read` implies delivery and is retained explicitly. */
export type OutboundLedgerStatus =
  | "pending"
  | "sending"
  | "sent"
  | "delivered"
  | "read"
  | "failed"
  | "unknown";

/** One provider delivery callback. */
export interface OutboundDeliveryStatusEvent {
  provider: string;
  provider_message_id: string;
  status: "sent" | "delivered" | "read" | "failed";
  occurred_at_iso?: string;
  error_code?: string;
}

/** Normalized ledger row; it never contains recipient or message content. */
export interface OutboundLedgerRecord {
  tenant_id: string;
  provider: string;
  operation_key: string;
  request_fingerprint: string;
  inbound_wamid: string | null;
  turn_id: string | null;
  status: OutboundLedgerStatus;
  provider_message_id: string | null;
  provider_status_code: string | null;
  error_code: string | null;
  attempt_count: number;
  lease_token: string | null;
  lease_expires_at: string | null;
  next_attempt_at: string | null;
  last_event_at: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  failed_at: string | null;
  unknown_at: string | null;
  retryable: boolean;
}

/** Input used to claim a provider operation exactly once. */
export interface OutboundLedgerClaimInput {
  tenant_id: string;
  provider: string;
  operation_key: string;
  request_fingerprint: string;
  inbound_wamid?: string;
  turn_id?: string;
  lease_seconds?: number;
}

/** Result of a durable claim attempt. */
export type OutboundLedgerClaim =
  | { kind: "send"; record: OutboundLedgerRecord; lease_token: string }
  | { kind: "replay"; record: OutboundLedgerRecord };

/** Outcome of a provider status callback. */
export type OutboundStatusUpdate = "updated" | "duplicate" | "ignored";

/** Persistence port used by the delivery wrapper and webhook status ingestion. */
export interface OutboundLedgerStore {
  /** Claim a send lease or replay a completed operation. */
  begin(input: OutboundLedgerClaimInput): Promise<OutboundLedgerClaim>;
  /** Commit a provider WAMID after successful transport I/O. */
  mark_sent(input: {
    tenant_id: string;
    provider: string;
    operation_key: string;
    lease_token: string;
    provider_message_id: string;
    provider_status_code?: string;
  }): Promise<OutboundLedgerRecord>;
  /** Record an explicit failure and whether a later retry is safe. */
  mark_failed(input: {
    tenant_id: string;
    provider: string;
    operation_key: string;
    lease_token: string;
    error_code: string;
    retryable: boolean;
    next_attempt_at?: string;
  }): Promise<OutboundLedgerRecord>;
  /** Record an ambiguous provider result that must not be resent automatically. */
  mark_unknown(input: {
    tenant_id: string;
    provider: string;
    operation_key: string;
    lease_token: string;
    error_code: string;
  }): Promise<OutboundLedgerRecord>;
  /** Apply a signed provider status callback monotonically. */
  record_status(tenant_id: string, event: OutboundDeliveryStatusEvent): Promise<OutboundStatusUpdate>;
}

/** Base safe ledger failure. */
export class OutboundLedgerError extends Error {
  readonly code: string;

  /** Create a sanitized ledger failure. */
  constructor(code: string, message = "outbound-ledger-failed", cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "OutboundLedgerError";
    this.code = code;
  }
}

/** Raised when a key is reused for a different semantic request. */
export class OutboundLedgerConflictError extends OutboundLedgerError {
  /** Create an operation-key conflict. */
  constructor() {
    super("outbound_ledger_conflict", "outbound-operation-conflict");
    this.name = "OutboundLedgerConflictError";
  }
}

/** Raised when a retryable operation is not yet eligible to run. */
export class OutboundLedgerNotReadyError extends OutboundLedgerError {
  readonly retry_at: Date;

  /** Create a safe not-ready failure. */
  constructor(retry_at: Date) {
    super("outbound_ledger_not_ready", "outbound-operation-not-ready");
    this.name = "OutboundLedgerNotReadyError";
    this.retry_at = retry_at;
  }
}

/** Raised when an existing send lease is still owned by another worker. */
export class OutboundLedgerInFlightError extends OutboundLedgerError {
  /** Create a lease conflict. */
  constructor() {
    super("outbound_ledger_in_flight", "outbound-operation-in-flight");
    this.name = "OutboundLedgerInFlightError";
  }
}

/** Raised when provider acceptance is ambiguous and operator reconciliation is required. */
export class OutboundLedgerUnknownError extends OutboundLedgerError {
  /** Create an ambiguous-result failure. */
  constructor() {
    super("outbound_ledger_unknown", "outbound-provider-result-unknown");
    this.name = "OutboundLedgerUnknownError";
  }
}

/** Derive a bounded operation key without persisting recipient or content. */
export function derive_outbound_operation_key(
  tenant_id: string,
  draft: Pick<OutboundDraft, "idempotency_key" | "inbound_wamid" | "turn_id">,
): string {
  if (draft.inbound_wamid === undefined) {
    const explicit = draft.idempotency_key;
    if (explicit !== undefined) return validate_token(explicit, "operation_key");
    throw new OutboundLedgerError("outbound_key_missing", "outbound-key-missing");
  }
  const turn = draft.turn_id ?? "0";
  const digest = createHash("sha256")
    .update(JSON.stringify([validate_token(tenant_id, "tenant_id"), validate_token(draft.inbound_wamid, "inbound_wamid"), validate_token(turn, "turn_id")]))
    .digest("hex");
  return `wa:${digest}`;
}

/** Hash operation identity and semantic content; only the digest is persisted. */
export function outbound_request_fingerprint(
  tenant_id: string,
  provider: string,
  operation_key: string,
  draft: Pick<OutboundDraft, "inbound_wamid" | "turn_id" | "message_type" | "text" | "buttons">,
): string {
  const semantic = {
    message_type: draft.message_type,
    text: draft.text,
    buttons: (draft.buttons ?? []).map((button) => ({ id: button.id, label: button.label, payload: button.payload ?? null })),
  };
  const semantic_json = JSON.stringify(semantic);
  if (semantic_json.length > 16_384) throw new OutboundLedgerError("outbound_request_too_large");
  return createHash("sha256")
    .update(JSON.stringify([
      validate_token(tenant_id, "tenant_id"),
      validate_provider(provider),
      validate_token(operation_key, "operation_key"),
      draft.inbound_wamid === undefined ? null : validate_token(draft.inbound_wamid, "inbound_wamid"),
      draft.turn_id === undefined ? null : validate_token(draft.turn_id, "turn_id"),
      semantic_json,
    ]))
    .digest("hex");
}

export interface NormalizedOutboundLedgerClaim {
  tenant_id: string;
  provider: string;
  operation_key: string;
  request_fingerprint: string;
  inbound_wamid?: string;
  turn_id?: string;
  lease_seconds: number;
}

interface MemoryClaimRow {
  record: OutboundLedgerRecord;
  lease_token: string;
}

/** Process-local ledger used only by explicit local mode and focused tests. */
export class InMemoryOutboundLedgerStore implements OutboundLedgerStore {
  private readonly rows = new Map<string, MemoryClaimRow>();
  private readonly clock: () => number;
  private readonly lease_seconds: number;

  /** Create an isolated ledger with a deterministic clock option. */
  constructor(clock: () => number = Date.now, lease_seconds = 30) {
    this.clock = clock;
    this.lease_seconds = positive_integer(lease_seconds, "lease_seconds");
  }

  /** Claim a send or replay a previously completed operation. */
  async begin(input: OutboundLedgerClaimInput): Promise<OutboundLedgerClaim> {
    const normalized = normalize_outbound_ledger_claim(input);
    const key = row_key(normalized.tenant_id, normalized.provider, normalized.operation_key);
    const now_ms = this.clock();
    const existing = this.rows.get(key);
    if (existing === undefined) {
      const created_at = new Date(now_ms).toISOString();
      const lease_token = randomUUID();
      const record: OutboundLedgerRecord = {
        tenant_id: normalized.tenant_id,
        provider: normalized.provider,
        operation_key: normalized.operation_key,
        request_fingerprint: normalized.request_fingerprint,
        inbound_wamid: normalized.inbound_wamid ?? null,
        turn_id: normalized.turn_id ?? null,
        status: "sending",
        provider_message_id: null,
        provider_status_code: null,
        error_code: null,
        attempt_count: 1,
        lease_token,
        lease_expires_at: new Date(now_ms + normalized.lease_seconds * 1_000).toISOString(),
        next_attempt_at: null,
        last_event_at: null,
        created_at,
        updated_at: created_at,
        sent_at: null,
        delivered_at: null,
        read_at: null,
        failed_at: null,
        unknown_at: null,
        retryable: false,
      };
      this.rows.set(key, { record, lease_token });
      return { kind: "send", record: copy_record(record), lease_token };
    }
    assert_fingerprint(existing.record, normalized.request_fingerprint);
    if (is_terminal_success(existing.record.status)) return { kind: "replay", record: copy_record(existing.record) };
    if (existing.record.status === "unknown") throw new OutboundLedgerUnknownError();
    if (existing.record.status === "sending" && lease_is_live(existing.record, now_ms)) {
      throw new OutboundLedgerInFlightError();
    }
    if (existing.record.status === "failed" && !existing.record.retryable) {
      throw new OutboundLedgerError("outbound_terminal", "outbound-operation-terminal");
    }
    if (existing.record.status === "failed" && existing.record.retryable && existing.record.next_attempt_at !== null) {
      const retry_at_ms = Date.parse(existing.record.next_attempt_at);
      if (Number.isFinite(retry_at_ms) && retry_at_ms > now_ms) {
        throw new OutboundLedgerNotReadyError(new Date(retry_at_ms));
      }
    }
    if (existing.record.status === "sending" && !lease_is_live(existing.record, now_ms)) {
      existing.record.status = "unknown";
      existing.record.unknown_at = new Date(now_ms).toISOString();
      existing.record.error_code = "lease_expired";
      existing.record.updated_at = existing.record.unknown_at;
      throw new OutboundLedgerUnknownError();
    }
    const lease_token = randomUUID();
    existing.lease_token = lease_token;
    existing.record.lease_token = lease_token;
    existing.record.lease_expires_at = new Date(now_ms + normalized.lease_seconds * 1_000).toISOString();
    existing.record.status = "sending";
    existing.record.attempt_count += 1;
    existing.record.error_code = null;
    existing.record.unknown_at = null;
    existing.record.retryable = false;
    existing.record.updated_at = new Date(now_ms).toISOString();
    return { kind: "send", record: copy_record(existing.record), lease_token };
  }

  /** Commit a provider WAMID under the active lease. */
  async mark_sent(input: Parameters<OutboundLedgerStore["mark_sent"]>[0]): Promise<OutboundLedgerRecord> {
    const row = this.active_row(input.tenant_id, input.provider, input.operation_key, input.lease_token);
    const provider_message_id = validate_provider_message_id(input.provider_message_id);
    const now = new Date(this.clock()).toISOString();
    row.record.status = "sent";
    row.record.provider_message_id = provider_message_id;
    row.record.provider_status_code = optional_code(input.provider_status_code, "provider_status_code");
    row.record.error_code = null;
    row.record.lease_token = null;
    row.record.lease_expires_at = null;
    row.record.next_attempt_at = null;
    row.record.sent_at = now;
    row.record.updated_at = now;
    return copy_record(row.record);
  }

  /** Record an explicit failure with retry policy. */
  async mark_failed(input: Parameters<OutboundLedgerStore["mark_failed"]>[0]): Promise<OutboundLedgerRecord> {
    const row = this.active_row(input.tenant_id, input.provider, input.operation_key, input.lease_token);
    const now = new Date(this.clock()).toISOString();
    row.record.status = "failed";
    row.record.error_code = validate_error_code(input.error_code);
    row.record.retryable = input.retryable;
    row.record.next_attempt_at = nullable_timestamp_input(input.next_attempt_at);
    row.record.lease_token = null;
    row.record.lease_expires_at = null;
    row.record.failed_at = now;
    row.record.updated_at = now;
    return copy_record(row.record);
  }

  /** Record an ambiguous result and prevent automatic duplicate sends. */
  async mark_unknown(input: Parameters<OutboundLedgerStore["mark_unknown"]>[0]): Promise<OutboundLedgerRecord> {
    const row = this.active_row(input.tenant_id, input.provider, input.operation_key, input.lease_token);
    const now = new Date(this.clock()).toISOString();
    row.record.status = "unknown";
    row.record.error_code = validate_error_code(input.error_code);
    row.record.lease_token = null;
    row.record.lease_expires_at = null;
    row.record.next_attempt_at = null;
    row.record.unknown_at = now;
    row.record.updated_at = now;
    return copy_record(row.record);
  }

  /** Apply a monotonic provider callback. */
  async record_status(tenant_id: string, event: OutboundDeliveryStatusEvent): Promise<OutboundStatusUpdate> {
    const provider = validate_provider(event.provider);
    const message_id = validate_provider_message_id(event.provider_message_id);
    const row = [...this.rows.values()].find((candidate) =>
      candidate.record.tenant_id === validate_tenant_id(tenant_id)
      && candidate.record.provider === provider
      && candidate.record.provider_message_id === message_id
    );
    if (row === undefined) return "ignored";
    return apply_status(row.record, event, new Date(this.clock()).toISOString());
  }

  /** Return a defensive row for tests and operator tooling. */
  get(tenant_id: string, provider: string, operation_key: string): OutboundLedgerRecord | null {
    const row = this.rows.get(row_key(tenant_id, provider, operation_key));
    return row === undefined ? null : copy_record(row.record);
  }

  private active_row(tenant_id: string, provider: string, operation_key: string, lease_token: string): MemoryClaimRow {
    const row = this.rows.get(row_key(tenant_id, provider, operation_key));
    if (row === undefined || row.lease_token !== lease_token || row.record.status !== "sending") {
      throw new OutboundLedgerError("outbound_lease_lost", "outbound-lease-lost");
    }
    return row;
  }
}

export function apply_status(
  record: OutboundLedgerRecord,
  event: OutboundDeliveryStatusEvent,
  now_iso: string,
): OutboundStatusUpdate {
  if (record.status === "failed") return "duplicate";
  if (event.occurred_at_iso !== undefined && !Number.isFinite(Date.parse(event.occurred_at_iso))) {
    throw new OutboundLedgerError("outbound_status_timestamp_invalid");
  }
  const current_rank = status_rank(record.status);
  const incoming_rank = status_rank(event.status);
  if (current_rank >= incoming_rank && current_rank >= status_rank("sent")) return "duplicate";
  const error_code = event.error_code === undefined ? null : validate_error_code(event.error_code);
  record.status = event.status;
  record.error_code = error_code;
  const event_at = event.occurred_at_iso ?? now_iso;
  record.last_event_at = event_at;
  record.updated_at = now_iso;
  if (event.status === "sent") record.sent_at ??= event_at;
  if (event.status === "delivered" || event.status === "read") record.delivered_at ??= event_at;
  if (event.status === "read") record.read_at = event_at;
  if (event.status === "failed") record.failed_at = event_at;
  return "updated";
}

export function status_rank(status: OutboundLedgerStatus): number {
  if (status === "pending") return 0;
  if (status === "sending") return 1;
  if (status === "sent") return 2;
  if (status === "delivered") return 3;
  if (status === "read") return 4;
  if (status === "failed") return 5;
  return 0;
}

export function normalize_outbound_ledger_claim(value: OutboundLedgerClaimInput): NormalizedOutboundLedgerClaim {
  if (typeof value !== "object" || value === null) throw new OutboundLedgerError("outbound_claim_invalid");
  return {
    tenant_id: validate_tenant_id(value.tenant_id),
    provider: validate_provider(value.provider),
    operation_key: validate_token(value.operation_key, "operation_key"),
    request_fingerprint: validate_fingerprint(value.request_fingerprint),
    inbound_wamid: value.inbound_wamid === undefined ? undefined : validate_token(value.inbound_wamid, "inbound_wamid"),
    turn_id: value.turn_id === undefined ? undefined : validate_token(value.turn_id, "turn_id"),
    lease_seconds: value.lease_seconds === undefined ? 30 : positive_integer(value.lease_seconds, "lease_seconds"),
  };
}

function validate_tenant_id(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new OutboundLedgerError("outbound_tenant_invalid");
  }
  return value;
}

function validate_provider(value: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) throw new OutboundLedgerError("outbound_provider_invalid");
  return value;
}

function validate_token(value: string, field_name: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new OutboundLedgerError(`outbound_${field_name}_invalid`);
  }
  return value;
}

function validate_fingerprint(value: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new OutboundLedgerError("outbound_fingerprint_invalid");
  return value;
}

function validate_provider_message_id(value: string): string {
  return validate_token(value, "provider_message_id");
}

function validate_error_code(value: string): string {
  if (!/^[a-z0-9_]{1,64}$/.test(value)) throw new OutboundLedgerError("outbound_error_code_invalid");
  return value;
}

function nullable_timestamp_input(value: string | undefined): string | null {
  if (value === undefined) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new OutboundLedgerError("outbound_next_attempt_at_invalid");
  return new Date(parsed).toISOString();
}

function optional_code(value: string | undefined, field_name: string): string | null {
  if (value === undefined) return null;
  if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(value)) throw new OutboundLedgerError(`outbound_${field_name}_invalid`);
  return value;
}

function positive_integer(value: number, field_name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 3_600) throw new OutboundLedgerError(`outbound_${field_name}_invalid`);
  return value;
}

function is_terminal_success(status: OutboundLedgerStatus): boolean {
  return status === "sent" || status === "delivered" || status === "read";
}

function lease_is_live(record: OutboundLedgerRecord, now_ms: number): boolean {
  return record.lease_expires_at !== null && Date.parse(record.lease_expires_at) > now_ms;
}

function assert_fingerprint(record: OutboundLedgerRecord, fingerprint: string): void {
  if (record.request_fingerprint !== fingerprint) throw new OutboundLedgerConflictError();
}

function row_key(tenant_id: string, provider: string, operation_key: string): string {
  return `${tenant_id}\u0000${provider}\u0000${operation_key}`;
}

function copy_record(record: OutboundLedgerRecord): OutboundLedgerRecord {
  return { ...record };
}
