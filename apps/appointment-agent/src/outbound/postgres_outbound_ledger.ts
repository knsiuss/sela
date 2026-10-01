/** Transactional Postgres adapter for the durable outbound ledger. */

import { createHash, randomUUID } from "node:crypto";
import type {
  SqlQueryResult,
  SqlTransactionClient,
  TransactionalSqlClient,
} from "../persistence/sql_client.js";
import {
  apply_status,
  normalize_outbound_ledger_claim,
  OutboundLedgerConflictError,
  OutboundLedgerError,
  OutboundLedgerInFlightError,
  OutboundLedgerNotReadyError,
  OutboundLedgerUnknownError,
  type NormalizedOutboundLedgerClaim,
  type OutboundDeliveryStatusEvent,
  type OutboundLedgerClaim,
  type OutboundLedgerClaimInput,
  type OutboundLedgerRecord,
  type OutboundLedgerStore,
  type OutboundStatusUpdate,
} from "./outbound_ledger.js";

const LOCK_OPERATION_SQL = `
  SELECT pg_advisory_xact_lock(hashtextextended($1, 0))
`;

const LOAD_OPERATION_SQL = `
  SELECT tenant_id::TEXT AS tenant_id, provider, operation_key, request_fingerprint,
         inbound_wamid, turn_id, status, provider_message_id, provider_status_code,
         error_code, attempt_count, retryable, lease_token, lease_expires_at,
         next_attempt_at, last_event_at, created_at, updated_at, sent_at,
         delivered_at, read_at, failed_at, unknown_at
  FROM public.outbound_ledger
  WHERE tenant_id = $1 AND provider = $2 AND operation_key = $3
  LIMIT 1
  FOR UPDATE
`;

const INSERT_OPERATION_SQL = `
  INSERT INTO public.outbound_ledger (
    tenant_id, provider, operation_key, request_fingerprint, inbound_wamid, turn_id,
    status, attempt_count, retryable, lease_token, lease_expires_at, created_at, updated_at
  )
  VALUES ($1, $2, $3, $4, $5, $6, 'sending', 1, false, $7, $8, now(), now())
  RETURNING tenant_id::TEXT AS tenant_id, provider, operation_key, request_fingerprint,
            inbound_wamid, turn_id, status, provider_message_id, provider_status_code,
            error_code, attempt_count, retryable, lease_token, lease_expires_at,
            next_attempt_at, last_event_at, created_at, updated_at, sent_at,
            delivered_at, read_at, failed_at, unknown_at
`;

const CLAIM_OPERATION_SQL = `
  UPDATE public.outbound_ledger
  SET status = 'sending',
      attempt_count = attempt_count + 1,
      retryable = false,
      error_code = NULL,
      unknown_at = NULL,
      next_attempt_at = NULL,
      lease_token = $4,
      lease_expires_at = $5,
      updated_at = now()
  WHERE tenant_id = $1 AND provider = $2 AND operation_key = $3
  RETURNING tenant_id::TEXT AS tenant_id, provider, operation_key, request_fingerprint,
            inbound_wamid, turn_id, status, provider_message_id, provider_status_code,
            error_code, attempt_count, retryable, lease_token, lease_expires_at,
            next_attempt_at, last_event_at, created_at, updated_at, sent_at,
            delivered_at, read_at, failed_at, unknown_at
`;

const MARK_UNKNOWN_SQL = `
  UPDATE public.outbound_ledger
  SET status = 'unknown', error_code = $4, unknown_at = now(), updated_at = now(),
      next_attempt_at = NULL, lease_token = NULL, lease_expires_at = NULL
  WHERE tenant_id = $1 AND provider = $2 AND operation_key = $3
    AND status = 'sending' AND lease_token = $5
  RETURNING tenant_id::TEXT AS tenant_id, provider, operation_key, request_fingerprint,
            inbound_wamid, turn_id, status, provider_message_id, provider_status_code,
            error_code, attempt_count, retryable, lease_token, lease_expires_at,
            next_attempt_at, last_event_at, created_at, updated_at, sent_at,
            delivered_at, read_at, failed_at, unknown_at
`;

const MARK_SENT_SQL = `
  UPDATE public.outbound_ledger
  SET status = 'sent', provider_message_id = $4, provider_status_code = $5,
      error_code = NULL, next_attempt_at = NULL, sent_at = now(), updated_at = now(),
      lease_token = NULL, lease_expires_at = NULL
  WHERE tenant_id = $1 AND provider = $2 AND operation_key = $3
    AND status = 'sending' AND lease_token = $6
  RETURNING tenant_id::TEXT AS tenant_id, provider, operation_key, request_fingerprint,
            inbound_wamid, turn_id, status, provider_message_id, provider_status_code,
            error_code, attempt_count, retryable, lease_token, lease_expires_at,
            next_attempt_at, last_event_at, created_at, updated_at, sent_at,
            delivered_at, read_at, failed_at, unknown_at
`;

const MARK_FAILED_SQL = `
  UPDATE public.outbound_ledger
  SET status = 'failed', error_code = $4, retryable = $5,
      next_attempt_at = $6::timestamptz, failed_at = now(), updated_at = now(),
      lease_token = NULL, lease_expires_at = NULL
  WHERE tenant_id = $1 AND provider = $2 AND operation_key = $3
    AND status = 'sending' AND lease_token = $7
  RETURNING tenant_id::TEXT AS tenant_id, provider, operation_key, request_fingerprint,
            inbound_wamid, turn_id, status, provider_message_id, provider_status_code,
            error_code, attempt_count, retryable, lease_token, lease_expires_at,
            next_attempt_at, last_event_at, created_at, updated_at, sent_at,
            delivered_at, read_at, failed_at, unknown_at
`;

const LOAD_BY_PROVIDER_MESSAGE_SQL = `
  SELECT tenant_id::TEXT AS tenant_id, provider, operation_key, request_fingerprint,
         inbound_wamid, turn_id, status, provider_message_id, provider_status_code,
         error_code, attempt_count, retryable, lease_token, lease_expires_at,
         next_attempt_at, last_event_at, created_at, updated_at, sent_at,
         delivered_at, read_at, failed_at, unknown_at
  FROM public.outbound_ledger
  WHERE tenant_id = $1 AND provider = $2 AND provider_message_id = $3
  LIMIT 1
  FOR UPDATE
`;

const UPDATE_STATUS_SQL = `
  UPDATE public.outbound_ledger
  SET status = $4, error_code = $5, last_event_at = $6, updated_at = now(),
      sent_at = CASE WHEN $4 = 'sent' THEN COALESCE(sent_at, $6) ELSE sent_at END,
      delivered_at = CASE WHEN $4 IN ('delivered', 'read') THEN COALESCE(delivered_at, $6) ELSE delivered_at END,
      read_at = CASE WHEN $4 = 'read' THEN $6 ELSE read_at END,
      failed_at = CASE WHEN $4 = 'failed' THEN $6 ELSE failed_at END
  WHERE tenant_id = $1 AND provider = $2 AND operation_key = $3
  RETURNING tenant_id::TEXT AS tenant_id, provider, operation_key, request_fingerprint,
            inbound_wamid, turn_id, status, provider_message_id, provider_status_code,
            error_code, attempt_count, retryable, lease_token, lease_expires_at,
            next_attempt_at, last_event_at, created_at, updated_at, sent_at,
            delivered_at, read_at, failed_at, unknown_at
`;

/** Transactional, tenant-scoped durable outbound ledger. */
export class PostgresOutboundLedgerStore implements OutboundLedgerStore {
  private readonly sql_client: TransactionalSqlClient;
  private readonly clock: () => number;

  /** Create a ledger over a transaction-capable SQL client. */
  constructor(sql_client: TransactionalSqlClient, clock: () => number = Date.now) {
    this.sql_client = sql_client;
    this.clock = clock;
  }

  /** Claim an operation or replay a completed result under one advisory lock. */
  async begin(input: OutboundLedgerClaimInput): Promise<OutboundLedgerClaim> {
    const normalized = normalize_outbound_ledger_claim(input);
    if (!/^[1-9]\d{0,18}$/.test(normalized.tenant_id)) {
      throw new OutboundLedgerError("outbound_tenant_invalid");
    }
    let expired = false;
    try {
      const result = await this.sql_client.with_transaction(async (transaction) => {
        await transaction.query(LOCK_OPERATION_SQL, [lock_key(normalized)]);
        const existing = await load_row(transaction, normalized);
        if (existing === null) return insert_row(transaction, normalized, this.clock);
        assert_fingerprint(existing, normalized.request_fingerprint);
        if (is_success(existing.status)) return { kind: "replay" as const, record: existing };
        if (existing.status === "unknown") throw new OutboundLedgerUnknownError();
        if (existing.status === "sending" && lease_is_live(existing, this.clock())) {
          throw new OutboundLedgerInFlightError();
        }
        if (existing.status === "sending" && !lease_is_live(existing, this.clock())) {
          await transaction.query(MARK_UNKNOWN_SQL, [
            normalized.tenant_id,
            normalized.provider,
            normalized.operation_key,
            "lease_expired",
            lease_token(existing),
          ]);
          expired = true;
          return null;
        }
        if (existing.status === "failed" && !existing.retryable) {
          return { kind: "replay" as const, record: existing };
        }
        if (existing.status === "failed" && existing.retryable && existing.next_attempt_at !== null) {
          const retry_at_ms = Date.parse(existing.next_attempt_at);
          if (Number.isFinite(retry_at_ms) && retry_at_ms > this.clock()) {
            throw new OutboundLedgerNotReadyError(new Date(retry_at_ms));
          }
        }
        const token = randomUUID();
        const claimed = await transaction.query(CLAIM_OPERATION_SQL, [
          normalized.tenant_id,
          normalized.provider,
          normalized.operation_key,
          token,
          new Date(this.clock() + normalized.lease_seconds * 1_000).toISOString(),
        ]);
        return { kind: "send" as const, record: require_row(claimed), lease_token: token };
      });
      if (expired) throw new OutboundLedgerUnknownError();
      if (result === null) throw new OutboundLedgerError("outbound_claim_result_invalid");
      return result;
    } catch (error) {
      throw translate_error(error);
    }
  }

  /** Commit a provider WAMID under the active lease. */
  async mark_sent(input: Parameters<OutboundLedgerStore["mark_sent"]>[0]): Promise<OutboundLedgerRecord> {
    try {
      const result = await this.sql_client.query(MARK_SENT_SQL, [
        input.tenant_id,
        input.provider,
        input.operation_key,
        input.provider_message_id,
        input.provider_status_code ?? null,
        input.lease_token,
      ]);
      return require_row(result);
    } catch (error) {
      throw translate_error(error);
    }
  }

  /** Record an explicit failure and retry policy. */
  async mark_failed(input: Parameters<OutboundLedgerStore["mark_failed"]>[0]): Promise<OutboundLedgerRecord> {
    try {
      validate_optional_timestamp(input.next_attempt_at);
      const result = await this.sql_client.query(MARK_FAILED_SQL, [
        input.tenant_id,
        input.provider,
        input.operation_key,
        input.error_code,
        input.retryable,
        input.next_attempt_at ?? null,
        input.lease_token,
      ]);
      return require_row(result);
    } catch (error) {
      throw translate_error(error);
    }
  }

  /** Record an ambiguous provider result and fence automatic retries. */
  async mark_unknown(input: Parameters<OutboundLedgerStore["mark_unknown"]>[0]): Promise<OutboundLedgerRecord> {
    try {
      const result = await this.sql_client.query(MARK_UNKNOWN_SQL, [
        input.tenant_id,
        input.provider,
        input.operation_key,
        input.error_code,
        input.lease_token,
      ]);
      return require_row(result);
    } catch (error) {
      throw translate_error(error);
    }
  }

  /** Apply a provider status callback under a row lock. */
  async record_status(tenant_id: string, event: OutboundDeliveryStatusEvent): Promise<OutboundStatusUpdate> {
    if (!/^[1-9]\d{0,18}$/.test(tenant_id)) throw new OutboundLedgerError("outbound_tenant_invalid");
    const normalized_event = normalize_event(event);
    try {
      return await this.sql_client.with_transaction(async (transaction) => {
        const result = await transaction.query(LOAD_BY_PROVIDER_MESSAGE_SQL, [
          tenant_id,
          normalized_event.provider,
          normalized_event.provider_message_id,
        ]);
        const current = optional_row(result);
        if (current === null) return "ignored" as const;
        const record = current;
        const decision = apply_status(record, normalized_event, new Date(this.clock()).toISOString());
        if (decision !== "updated") return decision;
        const updated = await transaction.query(UPDATE_STATUS_SQL, [
          tenant_id,
          normalized_event.provider,
          record.operation_key,
          record.status,
          record.error_code,
          record.last_event_at,
        ]);
        require_row(updated);
        return "updated" as const;
      });
    } catch (error) {
      throw translate_error(error);
    }
  }
}

async function load_row(
  transaction: SqlTransactionClient,
  claim: NormalizedOutboundLedgerClaim,
): Promise<OutboundLedgerRecord | null> {
  const result = await transaction.query(LOAD_OPERATION_SQL, [
    claim.tenant_id,
    claim.provider,
    claim.operation_key,
  ]);
  return optional_row(result);
}

async function insert_row(
  transaction: SqlTransactionClient,
  claim: NormalizedOutboundLedgerClaim,
  clock: () => number,
): Promise<OutboundLedgerClaim> {
  const token = randomUUID();
  const result = await transaction.query(INSERT_OPERATION_SQL, [
    claim.tenant_id,
    claim.provider,
    claim.operation_key,
    claim.request_fingerprint,
    claim.inbound_wamid ?? null,
    claim.turn_id ?? null,
    token,
    new Date(clock() + claim.lease_seconds * 1_000).toISOString(),
  ]);
  return { kind: "send", record: require_row(result), lease_token: token };
}

function optional_row(result: SqlQueryResult): OutboundLedgerRecord | null {
  if (!Array.isArray(result.rows)) throw new OutboundLedgerError("outbound_result_invalid");
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  if (typeof row !== "object" || row === null) throw new OutboundLedgerError("outbound_row_invalid");
  return normalize_row(row as Record<string, unknown>);
}

function require_row(result: SqlQueryResult): OutboundLedgerRecord {
  const row = optional_row(result);
  if (row === null) throw new OutboundLedgerError("outbound_update_conflict", "outbound-lease-lost");
  return row;
}

function normalize_row(row: Record<string, unknown>): OutboundLedgerRecord {
  const status = row.status;
  if (status !== "pending" && status !== "sending" && status !== "sent" && status !== "delivered" && status !== "read" && status !== "failed" && status !== "unknown") {
    throw new OutboundLedgerError("outbound_status_invalid");
  }
  return {
    tenant_id: string_value(row.tenant_id, "tenant_id"),
    provider: string_value(row.provider, "provider"),
    operation_key: string_value(row.operation_key, "operation_key"),
    request_fingerprint: string_value(row.request_fingerprint, "request_fingerprint"),
    inbound_wamid: nullable_string(row.inbound_wamid),
    turn_id: nullable_string(row.turn_id),
    status,
    provider_message_id: nullable_string(row.provider_message_id),
    provider_status_code: nullable_string(row.provider_status_code),
    error_code: nullable_string(row.error_code),
    attempt_count: integer_value(row.attempt_count, "attempt_count"),
    retryable: row.retryable === true,
    lease_token: nullable_string(row.lease_token),
    lease_expires_at: nullable_string(row.lease_expires_at),
    next_attempt_at: nullable_string(row.next_attempt_at),
    last_event_at: nullable_string(row.last_event_at),
    created_at: timestamp_value(row.created_at, "created_at"),
    updated_at: timestamp_value(row.updated_at, "updated_at"),
    sent_at: nullable_timestamp(row.sent_at),
    delivered_at: nullable_timestamp(row.delivered_at),
    read_at: nullable_timestamp(row.read_at),
    failed_at: nullable_timestamp(row.failed_at),
    unknown_at: nullable_timestamp(row.unknown_at),
  };
}

function normalize_event(value: OutboundDeliveryStatusEvent): OutboundDeliveryStatusEvent {
  if (typeof value !== "object" || value === null) throw new OutboundLedgerError("outbound_status_invalid");
  if (value.status !== "sent" && value.status !== "delivered" && value.status !== "read" && value.status !== "failed") {
    throw new OutboundLedgerError("outbound_status_invalid");
  }
  const provider = string_value(value.provider, "provider");
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(provider)) throw new OutboundLedgerError("outbound_provider_invalid");
  const error_code = value.error_code === undefined
    ? undefined
    : string_value(value.error_code, "error_code").toLowerCase();
  if (error_code !== undefined && !/^[a-z0-9_]{1,64}$/.test(error_code)) {
    throw new OutboundLedgerError("outbound_error_code_invalid");
  }
  return {
    provider,
    provider_message_id: string_value(value.provider_message_id, "provider_message_id"),
    status: value.status,
    occurred_at_iso: value.occurred_at_iso === undefined ? undefined : timestamp_value(value.occurred_at_iso, "occurred_at_iso"),
    ...(error_code === undefined ? {} : { error_code }),
  };
}

function string_value(value: unknown, field_name: string): string {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new OutboundLedgerError(`outbound_${field_name}_invalid`);
    return value.toISOString();
  }
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
    throw new OutboundLedgerError(`outbound_${field_name}_invalid`);
  }
  const normalized = String(value);
  if (normalized.trim() === "" || normalized.length > 256) throw new OutboundLedgerError(`outbound_${field_name}_invalid`);
  return normalized;
}

function nullable_string(value: unknown): string | null {
  return value === null || value === undefined ? null : string_value(value, "field");
}

function integer_value(value: unknown, field_name: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new OutboundLedgerError(`outbound_${field_name}_invalid`);
  return parsed;
}

function timestamp_value(value: unknown, field_name: string): string {
  const text = string_value(value, field_name);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) throw new OutboundLedgerError(`outbound_${field_name}_invalid`);
  return new Date(parsed).toISOString();
}

function nullable_timestamp(value: unknown): string | null {
  return value === null || value === undefined ? null : timestamp_value(value, "timestamp");
}

function lock_key(claim: NormalizedOutboundLedgerClaim): string {
  return createHash("sha256")
    .update(JSON.stringify(["outbound-operation-v1", claim.tenant_id, claim.provider, claim.operation_key]))
    .digest("hex");
}

function assert_fingerprint(record: OutboundLedgerRecord, fingerprint: string): void {
  if (record.request_fingerprint !== fingerprint) throw new OutboundLedgerConflictError();
}

function is_success(status: OutboundLedgerRecord["status"]): boolean {
  return status === "sent" || status === "delivered" || status === "read";
}

function lease_is_live(record: OutboundLedgerRecord, now_ms: number): boolean {
  return record.lease_expires_at !== null && Date.parse(record.lease_expires_at) > now_ms;
}

function lease_token(record: OutboundLedgerRecord): string {
  if (record.lease_token === null) throw new OutboundLedgerError("outbound_lease_missing");
  return record.lease_token;
}

function validate_optional_timestamp(value: string | undefined): void {
  if (value !== undefined && !Number.isFinite(Date.parse(value))) {
    throw new OutboundLedgerError("outbound_next_attempt_at_invalid");
  }
}

function translate_error(error: unknown): unknown {
  const ledger_error = find_ledger_error(error);
  if (ledger_error !== null) return ledger_error;
  return new OutboundLedgerError("outbound_persistence_failed", "outbound-ledger-failed", error);
}

function find_ledger_error(error: unknown): OutboundLedgerError | null {
  let current: unknown = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (current instanceof OutboundLedgerError) return current;
    if (!current || typeof current !== "object" || !("cause" in current)) return null;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}
