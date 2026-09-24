/** Atomic tenant-scoped persistence boundary for one inbound webhook message. */

import { assert_valid_wamid } from "./dedupe_contract.js";
import type { InboundMessageRecord } from "./inbound_store.js";
import type {
  SqlClient,
  SqlQueryResult,
  SqlTransactionClient,
  SqlTransactionWork,
} from "../persistence/sql_client.js";

/** Stable failure at the atomic ingress persistence boundary. */
export class AtomicIngressStoreError extends Error {
  /** Create a safe atomic ingress error. */
  constructor(reason = "atomic-ingress-store-failed", cause?: unknown) {
    super(reason, cause === undefined ? undefined : { cause });
    this.name = "AtomicIngressStoreError";
  }
}

/** Validated data for one tenant-scoped inbound message and its queue job. */
export interface AtomicIngressInput {
  /** Tenant resolved from the provider channel. */
  tenant_id: string;
  /** Request correlation id; never message content. */
  request_id: string;
  /** Server receipt timestamp copied to the worker job. */
  received_at_iso: string;
  /** Retained inbound row, including an encrypted reply target. */
  inbound_record: InboundMessageRecord;
}

/** A newly committed inbound row and worker job. */
export interface AcceptedAtomicIngress {
  status: "accepted";
  tenant_id: string;
  wamid: string;
}

/** A message already claimed for this tenant. */
export interface DuplicateAtomicIngress {
  status: "duplicate";
  tenant_id: string;
  wamid: string;
}

/** Typed outcome of one atomic ingress attempt. */
export type AtomicIngressResult = AcceptedAtomicIngress | DuplicateAtomicIngress;

/** Narrow port consumed by the webhook boundary. */
export interface AtomicIngressStore {
  /** Atomically accept one message or report its tenant-scoped duplicate. */
  accept(input: AtomicIngressInput): Promise<AtomicIngressResult>;
}

// A WAMID is idempotent only within its tenant; the composite key prevents cross-tenant suppression.
const CLAIM_MESSAGE_SQL = `
  INSERT INTO processed_messages (tenant_id, wamid)
  VALUES ($1, $2)
  ON CONFLICT (tenant_id, wamid) DO NOTHING
  RETURNING tenant_id, wamid
`;

const INSERT_INBOUND_SQL = `
  INSERT INTO inbound_messages (
    tenant_id, wamid, conversation_id, message_type, button_id, sender_ref,
    reply_target_ciphertext, message_text, received_at, expires_at
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  RETURNING id
`;

const INSERT_JOB_SQL = `
  INSERT INTO webhook_jobs (
    tenant_id, request_id, wamid, conversation_id, received_at_iso
  )
  VALUES ($1, $2, $3, $4, $5)
  RETURNING id
`;

const ENCRYPTED_TARGET_PATTERN = /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** Transactional PostgreSQL implementation of the narrow ingress port. */
export class PostgresAtomicIngressStore implements AtomicIngressStore {
  private readonly sql_client: SqlClient;

  /** Create the store over the application's transaction-capable SQL client. */
  constructor(sql_client: SqlClient) {
    this.sql_client = sql_client;
  }

  /**
   * Claim, retain, and enqueue one message in a single database transaction.
   *
   * Duplicate claims commit without touching either durable payload table.
   * Any claim, write, or result-shape failure propagates so the transaction
   * runner can roll back every preceding write.
   *
   * @param input - Validated inbound record and PII-free job metadata.
   * @returns An accepted or tenant-scoped duplicate result after commit.
   * @throws AtomicIngressStoreError when the transaction is unavailable or fails.
   */
  async accept(input: AtomicIngressInput): Promise<AtomicIngressResult> {
    const normalized = validate_input(input);
    const with_transaction = this.sql_client.with_transaction;
    if (typeof with_transaction !== "function") {
      throw new AtomicIngressStoreError("atomic-ingress-transaction-unavailable");
    }

    try {
      const run_transaction = with_transaction.bind(this.sql_client) as <T>(
        work: SqlTransactionWork<T>,
      ) => Promise<T>;
      return await run_transaction<AtomicIngressResult>(async (transaction) => {
        const claimed = await claim_message(transaction, normalized.tenant_id, normalized.inbound_record.wamid);
        if (!claimed) {
          return {
            status: "duplicate",
            tenant_id: normalized.tenant_id,
            wamid: normalized.inbound_record.wamid,
          } satisfies DuplicateAtomicIngress;
        }

        await insert_inbound_message(transaction, normalized.inbound_record);
        await insert_webhook_job(transaction, normalized);
        return {
          status: "accepted",
          tenant_id: normalized.tenant_id,
          wamid: normalized.inbound_record.wamid,
        } satisfies AcceptedAtomicIngress;
      });
    } catch (error) {
      if (error instanceof AtomicIngressStoreError) throw error;
      throw new AtomicIngressStoreError("atomic-ingress-persistence-failed", error);
    }
  }
}

async function claim_message(
  transaction: SqlTransactionClient,
  tenant_id: string,
  wamid: string,
): Promise<boolean> {
  const result = await transaction.query(CLAIM_MESSAGE_SQL, [tenant_id, wamid]);
  const shape = result_shape(result, "atomic-ingress-claim-result-invalid");
  if (shape.count === 0) return false;
  if (shape.count !== 1) throw new AtomicIngressStoreError("atomic-ingress-claim-result-invalid");
  if (shape.rows !== undefined) {
    const row = shape.rows[0];
    if (!is_record(row)) throw new AtomicIngressStoreError("atomic-ingress-claim-row-invalid");
    const returned_tenant_id = identifier_value(row["tenant_id"]);
    const returned_wamid = row["wamid"];
    if (returned_tenant_id !== tenant_id || returned_wamid !== wamid) {
      throw new AtomicIngressStoreError("atomic-ingress-claim-row-invalid");
    }
  }
  return true;
}

async function insert_inbound_message(
  transaction: SqlTransactionClient,
  record: InboundMessageRecord,
): Promise<void> {
  const result = await transaction.query(INSERT_INBOUND_SQL, [
    record.tenant_id,
    record.wamid,
    record.conversation_id,
    record.message_type,
    record.button_id,
    record.sender_ref,
    record.reply_target_ciphertext,
    record.message_text,
    record.received_at,
    record.expires_at,
  ]);
  require_inserted(result, "atomic-ingress-inbound-result-invalid");
}

async function insert_webhook_job(
  transaction: SqlTransactionClient,
  input: AtomicIngressInput,
): Promise<void> {
  const result = await transaction.query(INSERT_JOB_SQL, [
    input.tenant_id,
    input.request_id,
    input.inbound_record.wamid,
    input.inbound_record.conversation_id,
    input.received_at_iso,
  ]);
  require_inserted(result, "atomic-ingress-job-result-invalid");
}

function require_inserted(result: SqlQueryResult, reason: string): void {
  const shape = result_shape(result, reason);
  if (shape.count !== 1) throw new AtomicIngressStoreError(reason);
  if (shape.rows !== undefined) {
    const row = shape.rows[0];
    if (!is_record(row) || identifier_value(row["id"]) === undefined) {
      throw new AtomicIngressStoreError(reason);
    }
  }
}

function result_shape(
  result: SqlQueryResult,
  reason: string,
): { rows: unknown[] | undefined; count: number } {
  if (!is_record(result)) throw new AtomicIngressStoreError(reason);
  const raw_rows = result["rows"];
  const raw_count = result["rowCount"];
  const has_rows = Array.isArray(raw_rows);
  const has_count = raw_count !== undefined && raw_count !== null;
  if (!has_rows && !has_count) throw new AtomicIngressStoreError(reason);
  if (has_count && (typeof raw_count !== "number" || !Number.isSafeInteger(raw_count) || raw_count < 0)) {
    throw new AtomicIngressStoreError(reason);
  }
  const rows = has_rows ? (raw_rows as unknown[]) : undefined;
  const count = has_rows ? rows!.length : (raw_count as number);
  if (has_rows && has_count && rows!.length !== raw_count) {
    throw new AtomicIngressStoreError(reason);
  }
  return { rows, count };
}

function validate_input(input: AtomicIngressInput): AtomicIngressInput {
  if (!is_record(input)) throw new AtomicIngressStoreError("atomic-ingress-input-invalid");
  const tenant_id = require_id(input.tenant_id, "tenant_id");
  const request_id = require_id(input.request_id, "request_id", 128);
  valid_timestamp(input.received_at_iso, "received_at_iso");
  const record = input.inbound_record;
  if (!is_record(record)) throw new AtomicIngressStoreError("atomic-ingress-record-invalid");
  if (record.tenant_id !== tenant_id) {
    throw new AtomicIngressStoreError("atomic-ingress-tenant-scope-invalid");
  }
  try {
    assert_valid_wamid(record.wamid);
  } catch (error) {
    throw new AtomicIngressStoreError("atomic-ingress-wamid-invalid", error);
  }
  require_id(record.conversation_id, "conversation_id", 128);
  require_id(record.message_type, "message_type", 64);
  if (record.button_id !== null) require_id(record.button_id, "button_id", 64);
  require_id(record.sender_ref, "sender_ref", 256);
  require_ciphertext(record.reply_target_ciphertext);
  require_text(record.message_text);
  const received_at = valid_timestamp(record.received_at, "received_at");
  const expires_at = valid_timestamp(record.expires_at, "expires_at");
  if (expires_at <= received_at) throw new AtomicIngressStoreError("atomic-ingress-expiry-invalid");
  if (record.processed_at !== undefined && record.processed_at !== null) {
    valid_timestamp(record.processed_at, "processed_at");
    throw new AtomicIngressStoreError("atomic-ingress-record-not-new");
  }
  return {
    tenant_id,
    request_id,
    received_at_iso: input.received_at_iso,
    inbound_record: record,
  };
}

function require_id(value: unknown, field_name: string, max_length = 256): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max_length) {
    throw new AtomicIngressStoreError(`atomic-ingress-${field_name}-invalid`);
  }
  return value;
}

function require_text(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 4096) {
    throw new AtomicIngressStoreError("atomic-ingress-message_text-invalid");
  }
  return value;
}

function require_ciphertext(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || !ENCRYPTED_TARGET_PATTERN.test(value)) {
    throw new AtomicIngressStoreError("atomic-ingress-reply-target-invalid");
  }
  return value;
}

function valid_timestamp(value: unknown, field_name: string): number {
  if (typeof value !== "string") {
    throw new AtomicIngressStoreError(`atomic-ingress-${field_name}-invalid`);
  }
  const timestamp_ms = Date.parse(value);
  if (!Number.isFinite(timestamp_ms)) {
    throw new AtomicIngressStoreError(`atomic-ingress-${field_name}-invalid`);
  }
  return timestamp_ms;
}

function identifier_value(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "bigint") return String(value);
  return undefined;
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
