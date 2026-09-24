/** Persistence boundary for retained, tenant-scoped inbound WhatsApp messages. */

import type { InboundMessage } from "../agent_types.js";
import type { SqlClient, SqlQueryResult } from "../persistence/sql_client.js";
import type { RecipientCipher } from "../security/recipient_cipher.js";

/** Default retention period for message text, sender references, and encrypted targets. */
export const DEFAULT_INBOUND_RETENTION_DAYS = 30;

/** Stable failure at the inbound persistence boundary. */
export class InboundMessageStoreError extends Error {
  /** Create a safe persistence error. */
  constructor(reason = "inbound-message-store-failed", cause?: unknown) {
    super(reason, cause === undefined ? undefined : { cause });
    this.name = "InboundMessageStoreError";
  }
}

/** One row persisted in inbound_messages. */
export interface InboundMessageRecord {
  /** Tenant that owns the channel mapping. */
  tenant_id: string;
  /** Stable Meta inbound message id. */
  wamid: string;
  /** Hashed conversation key used by the job and graph. */
  conversation_id: string;
  /** Normalized text or button-reply type. */
  message_type: string;
  /** Validated quick-reply action id, or null for text and legacy rows. */
  button_id: string | null;
  /** Opaque sender reference; raw phone numbers are not stored here. */
  sender_ref: string;
  /** Versioned encrypted reply target; null only for legacy rows. */
  reply_target_ciphertext: string | null;
  /** Retained message text, bounded by the ingress contract. */
  message_text: string;
  /** ISO timestamp supplied by the inbound message. */
  received_at: string;
  /** ISO retention deadline. */
  expires_at: string;
  /** ISO processing timestamp, when the worker has completed the row. */
  processed_at?: string | null;
}

/** Port used by ingress and worker boundaries. */
export interface InboundMessageStore {
  /** Insert a row idempotently; false means the tenant/wamid already exists. */
  save(record: InboundMessageRecord): Promise<boolean>;
  /** Load one row scoped by tenant and wamid. */
  get(tenant_id: string, wamid: string): Promise<InboundMessageRecord | null>;
  /** Mark a row processed without changing its retained content. */
  mark_processed(tenant_id: string, wamid: string, processed_at: string): Promise<void>;
}

/** Options for SQL-backed retention behavior. */
export interface InboundMessageStoreOptions {
  /** Retention used when callers do not provide an explicit expiry. */
  retention_days?: number;
}

/** Build a bounded retention record from a validated inbound message. */
export function build_inbound_message_record(input: {
  tenant_id: string;
  message: InboundMessage;
  recipient_cipher: RecipientCipher;
  conversation_id: string;
  sender_ref?: string;
  retention_days?: number;
  now?: string;
}): InboundMessageRecord {
  const tenant_id = require_id(input.tenant_id, "tenant_id");
  const conversation_id = require_id(input.conversation_id, "conversation_id");
  const sender_ref = require_id(input.sender_ref ?? input.conversation_id, "sender_ref");
  const reply_target_ciphertext = require_reply_target_ciphertext(
    input.recipient_cipher.encrypt(input.message.sender_phone_e164),
  );
  const received_at = valid_timestamp(input.message.sent_at_iso, "received_at");
  const retention_days = positive_integer(
    input.retention_days ?? DEFAULT_INBOUND_RETENTION_DAYS,
    "retention_days",
  );
  const expires_at = new Date(
    Date.parse(received_at) + retention_days * 24 * 60 * 60 * 1000,
  ).toISOString();
  return {
    tenant_id,
    wamid: require_id(input.message.wamid, "wamid"),
    conversation_id,
    message_type: input.message.message_kind,
    button_id: input.message.button_id ?? null,
    sender_ref,
    reply_target_ciphertext,
    message_text: require_text(input.message.text_body, "message_text"),
    received_at,
    expires_at,
    processed_at: null,
  };
}

const INSERT_INBOUND_SQL = `
  INSERT INTO inbound_messages (
    tenant_id, wamid, conversation_id, message_type, button_id, sender_ref,
    reply_target_ciphertext, message_text, received_at, expires_at
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  ON CONFLICT (tenant_id, wamid) DO NOTHING
  RETURNING id
`;

const SELECT_INBOUND_SQL = `
  SELECT tenant_id, wamid, conversation_id, message_type, button_id, sender_ref,
         reply_target_ciphertext, message_text, received_at, expires_at, processed_at
  FROM inbound_messages
  WHERE tenant_id = $1 AND wamid = $2
  LIMIT 1
`;

const MARK_PROCESSED_SQL = `
  UPDATE inbound_messages
  SET processed_at = $3
  WHERE tenant_id = $1 AND wamid = $2
`;

/** In-memory store for tests and the explicit USE_IN_MEMORY composition. */
export class InMemoryInboundMessageStore implements InboundMessageStore {
  private readonly rows = new Map<string, InboundMessageRecord>();

  /**
   * Return a copy of all retained rows for test assertions.
   *
   * @returns Defensive copies in insertion order.
   */
  all(): InboundMessageRecord[] {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }

  /**
   * Insert one row idempotently.
   *
   * @param record - Validated tenant-scoped inbound record.
   * @returns True when inserted, false for a duplicate tenant/wamid.
   */
  async save(record: InboundMessageRecord): Promise<boolean> {
    validate_new_record(record);
    const key = row_key(record.tenant_id, record.wamid);
    if (this.rows.has(key)) return false;
    this.rows.set(key, { ...record });
    return true;
  }

  /** Alias for callers that name the operation insert. */
  async insert(record: InboundMessageRecord): Promise<boolean> {
    return this.save(record);
  }

  /**
   * Load one row by tenant and wamid.
   *
   * @param tenant_id - Owning tenant.
   * @param wamid - Stable message id.
   * @returns A defensive row copy or null.
   */
  async get(tenant_id: string, wamid: string): Promise<InboundMessageRecord | null> {
    require_id(tenant_id, "tenant_id");
    require_id(wamid, "wamid");
    const row = this.rows.get(row_key(tenant_id, wamid));
    return row === undefined ? null : { ...row };
  }

  /** Alias for worker-oriented callers. */
  async load(tenant_id: string, wamid: string): Promise<InboundMessageRecord | null> {
    return this.get(tenant_id, wamid);
  }

  /**
   * Mark one row processed.
   *
   * @param tenant_id - Owning tenant.
   * @param wamid - Stable message id.
   * @param processed_at - ISO completion timestamp.
   * @returns Nothing when the row is updated or already absent.
   */
  async mark_processed(tenant_id: string, wamid: string, processed_at: string): Promise<void> {
    require_id(tenant_id, "tenant_id");
    require_id(wamid, "wamid");
    valid_timestamp(processed_at, "processed_at");
    const key = row_key(tenant_id, wamid);
    const row = this.rows.get(key);
    if (row !== undefined) this.rows.set(key, { ...row, processed_at });
  }
}

/** Parameterized Postgres store for inbound_messages. */
export class PostgresInboundMessageStore implements InboundMessageStore {
  private readonly sql_client: SqlClient;
  private readonly retention_days: number;

  /**
   * Create a Postgres inbound store.
   *
   * @param sql_client - Server-side SQL boundary.
   * @param options - Optional retention policy for future callers.
   */
  constructor(sql_client: SqlClient, options: InboundMessageStoreOptions = {}) {
    this.sql_client = sql_client;
    this.retention_days = positive_integer(
      options.retention_days ?? DEFAULT_INBOUND_RETENTION_DAYS,
      "retention_days",
    );
  }

  /**
   * Insert one retained inbound row idempotently.
   *
   * @param record - Validated inbound row.
   * @returns True when inserted, false for a duplicate.
   */
  async save(record: InboundMessageRecord): Promise<boolean> {
    validate_new_record(record);
    try {
      const result = await this.sql_client.query(INSERT_INBOUND_SQL, [
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
      return inserted(result);
    } catch (error) {
      if (error instanceof InboundMessageStoreError) throw error;
      throw new InboundMessageStoreError("inbound-message-insert-failed", error);
    }
  }

  /**
   * Load one retained row scoped to its tenant.
   *
   * @param tenant_id - Owning tenant.
   * @param wamid - Stable message id.
   * @returns A normalized row or null.
   */
  async get(tenant_id: string, wamid: string): Promise<InboundMessageRecord | null> {
    require_id(tenant_id, "tenant_id");
    require_id(wamid, "wamid");
    try {
      const result = await this.sql_client.query(SELECT_INBOUND_SQL, [tenant_id, wamid]);
      const row = first_row(result);
      return row === undefined ? null : normalize_row(row);
    } catch (error) {
      if (error instanceof InboundMessageStoreError) throw error;
      throw new InboundMessageStoreError("inbound-message-read-failed", error);
    }
  }

  /**
   * Mark one retained row processed.
   *
   * @param tenant_id - Owning tenant.
   * @param wamid - Stable message id.
   * @param processed_at - ISO completion timestamp.
   * @returns Nothing.
   */
  async mark_processed(tenant_id: string, wamid: string, processed_at: string): Promise<void> {
    require_id(tenant_id, "tenant_id");
    require_id(wamid, "wamid");
    valid_timestamp(processed_at, "processed_at");
    try {
      await this.sql_client.query(MARK_PROCESSED_SQL, [tenant_id, wamid, processed_at]);
    } catch (error) {
      throw new InboundMessageStoreError("inbound-message-update-failed", error);
    }
  }
}

function inserted(result: SqlQueryResult): boolean {
  if (Array.isArray(result.rows)) return result.rows.length > 0;
  if (typeof result.rowCount === "number") return result.rowCount > 0;
  throw new InboundMessageStoreError("inbound-message-insert-result-invalid");
}

function first_row(result: SqlQueryResult): Record<string, unknown> | undefined {
  if (!Array.isArray(result.rows) || result.rows.length === 0) return undefined;
  const row = result.rows[0];
  return is_record(row) ? row : undefined;
}

function normalize_row(row: Record<string, unknown>): InboundMessageRecord {
  const record: InboundMessageRecord = {
    tenant_id: require_id(string_value(row["tenant_id"]), "tenant_id"),
    wamid: require_id(string_value(row["wamid"]), "wamid"),
    conversation_id: require_id(string_value(row["conversation_id"]), "conversation_id"),
    message_type: require_text(string_value(row["message_type"]), "message_type"),
    button_id: nullable_button_id(row["button_id"]),
    sender_ref: require_id(string_value(row["sender_ref"]), "sender_ref"),
    reply_target_ciphertext: nullable_reply_target(row["reply_target_ciphertext"]),
    message_text: require_text(string_value(row["message_text"]), "message_text"),
    received_at: valid_timestamp(string_value(row["received_at"]), "received_at"),
    expires_at: valid_timestamp(string_value(row["expires_at"]), "expires_at"),
    processed_at: nullable_timestamp(row["processed_at"], "processed_at"),
  };
  validate_record(record);
  return record;
}

function validate_new_record(record: InboundMessageRecord): void {
  validate_record(record);
  require_reply_target_ciphertext(record.reply_target_ciphertext);
}

function validate_record(record: InboundMessageRecord): void {
  require_id(record.tenant_id, "tenant_id");
  require_id(record.wamid, "wamid");
  require_id(record.conversation_id, "conversation_id");
  if (typeof record.message_type !== "string" || record.message_type.trim() === "" || record.message_type.length > 64) {
    throw new InboundMessageStoreError("inbound-message_type-invalid");
  }
  if (record.button_id !== null) require_button_id(record.button_id);
  require_id(record.sender_ref, "sender_ref");
  if (record.reply_target_ciphertext !== null) {
    require_reply_target_ciphertext(record.reply_target_ciphertext);
  }
  require_text(record.message_text, "message_text");
  const received_ms = valid_timestamp(record.received_at, "received_at");
  const expires_ms = valid_timestamp(record.expires_at, "expires_at");
  if (expires_ms <= received_ms) throw new InboundMessageStoreError("inbound-expiry-invalid");
  if (record.processed_at !== undefined && record.processed_at !== null) {
    valid_timestamp(record.processed_at, "processed_at");
  }
}

function row_key(tenant_id: string, wamid: string): string {
  return `${tenant_id}\u0000${wamid}`;
}

function require_id(value: string, field_name: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 256) {
    throw new InboundMessageStoreError(`inbound-${field_name}-invalid`);
  }
  return value;
}

function require_text(value: string, field_name: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 4096) {
    throw new InboundMessageStoreError(`inbound-${field_name}-invalid`);
  }
  return value;
}

function require_reply_target_ciphertext(value: string | null): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new InboundMessageStoreError("inbound-reply-target-invalid");
  }
  return value;
}

function nullable_reply_target(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return require_reply_target_ciphertext(string_value(value));
}

function require_button_id(value: string): string {
  if (value.trim() === "" || value.length > 64) {
    throw new InboundMessageStoreError("inbound-button_id-invalid");
  }
  return value;
}

function nullable_button_id(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return require_button_id(string_value(value));
}

function valid_timestamp(value: string, field_name: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new InboundMessageStoreError(`inbound-${field_name}-invalid`);
  }
  return value;
}

function nullable_timestamp(value: unknown, field_name: string): string | null {
  if (value === undefined || value === null) return null;
  return valid_timestamp(string_value(value), field_name);
}

function string_value(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  throw new InboundMessageStoreError("inbound-row-invalid");
}

function positive_integer(value: number, field_name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 3650) {
    throw new InboundMessageStoreError(`inbound-${field_name}-invalid`);
  }
  return value;
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
