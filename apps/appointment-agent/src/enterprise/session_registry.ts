/** Session revocation and PII-free device history. */

import { createHash } from "node:crypto";

/** One login session; device leaves only as a one-way hash. */
export interface SessionRecord {
  session_id: string;
  subject_id: string;
  tenant_id: string;
  device_hash: string;
  created_at_iso: string;
  last_seen_at_iso: string;
  revoked_at_iso: string | null;
}

/** Input for registering a session. */
export interface RegisterSessionInput {
  session_id: string;
  subject_id: string;
  tenant_id: string;
  device_id: string;
  clock?: () => Date;
}

/** Failure with a stable machine-readable code. */
export class SessionError extends Error {
  readonly code: string;

  /** Create a sanitized session failure. */
  constructor(code: string) {
    super(code);
    this.name = "SessionError";
    this.code = code;
  }
}

/**
 * Register a session; the raw device id never persists.
 *
 * @param input - Session identifiers and raw device id.
 * @returns New active session record.
 */
export function register_session(input: RegisterSessionInput): SessionRecord {
  if (typeof input !== "object" || input === null) throw new SessionError("session-invalid");
  const session_id = require_safe_id(input.session_id);
  const subject_id = require_safe_id(input.subject_id);
  require_tenant_id(input.tenant_id);
  if (typeof input.device_id !== "string" || input.device_id.length < 1 || input.device_id.length > 512) {
    throw new SessionError("session-device-invalid");
  }
  const now = (input.clock ?? (() => new Date()))().toISOString();
  return {
    session_id, subject_id, tenant_id: input.tenant_id,
    device_hash: hash_device(input.device_id),
    created_at_iso: now, last_seen_at_iso: now, revoked_at_iso: null,
  };
}

/**
 * Refresh last-seen on an active session.
 *
 * @param record - Current record.
 * @param clock - Optional clock.
 * @returns Updated record.
 */
export function touch_session(record: SessionRecord, clock: () => Date = () => new Date()): SessionRecord {
  const current = require_record(record);
  if (current.revoked_at_iso !== null) throw new SessionError("session-revoked");
  return { ...current, last_seen_at_iso: clock().toISOString() };
}

/**
 * Revoke a session; a second revoke fails loudly.
 *
 * @param record - Current record.
 * @param clock - Optional clock.
 * @returns Revoked record.
 */
export function revoke_session(record: SessionRecord, clock: () => Date = () => new Date()): SessionRecord {
  const current = require_record(record);
  if (current.revoked_at_iso !== null) throw new SessionError("session-already-revoked");
  return { ...current, revoked_at_iso: clock().toISOString() };
}

/**
 * Return true when the record is revoked.
 *
 * @param record - Record to inspect.
 * @returns True when revoked.
 */
export function is_session_revoked(record: SessionRecord): boolean {
  return require_record(record).revoked_at_iso !== null;
}

/**
 * List PII-free session history for one subject, newest first.
 *
 * @param records - Candidate records.
 * @param subject_id - Subject filter.
 * @returns Copies sorted by last seen descending.
 */
export function list_subject_sessions(records: readonly SessionRecord[], subject_id: string): SessionRecord[] {
  require_safe_id(subject_id);
  if (!Array.isArray(records)) throw new SessionError("session-records-invalid");
  return records
    .filter((record) => record.subject_id === subject_id)
    .map((record) => ({ ...require_record(record) }))
    .sort((left, right) => Date.parse(right.last_seen_at_iso) - Date.parse(left.last_seen_at_iso));
}

/** In-memory session adapter for tests and explicit local mode. */
export class InMemorySessionRegistry {
  private readonly rows = new Map<string, SessionRecord>();

  /**
   * Persist a registered session.
   *
   * @param input - Registration input.
   * @returns The stored record.
   */
  async register(input: RegisterSessionInput): Promise<SessionRecord> {
    const record = register_session(input);
    if (this.rows.has(record.session_id)) throw new SessionError("session-already-exists");
    this.rows.set(record.session_id, record);
    return { ...record };
  }

  /**
   * Read one session.
   *
   * @param session_id - Session identifier.
   * @returns A copy or null.
   */
  async get(session_id: string): Promise<SessionRecord | null> {
    const found = this.rows.get(session_id);
    return found === undefined ? null : { ...found };
  }

  /**
   * Persist an updated record.
   *
   * @param record - Updated record.
   */
  async save(record: SessionRecord): Promise<void> {
    this.rows.set(require_record(record).session_id, { ...record });
  }
}

/**
 * Hash a device identifier; raw values never leave the caller.
 *
 * @param device_id - Raw device identifier.
 * @returns Hex digest.
 */
export function hash_device(device_id: string): string {
  return createHash("sha256").update(device_id, "utf8").digest("hex");
}

function require_record(value: SessionRecord): SessionRecord {
  if (typeof value !== "object" || value === null) throw new SessionError("session-invalid");
  require_safe_id(value.session_id);
  require_safe_id(value.subject_id);
  require_tenant_id(value.tenant_id);
  if (!/^[0-9a-f]{64}$/.test(value.device_hash)) throw new SessionError("session-invalid");
  return value;
}

function require_tenant_id(value: string): string {
  if (typeof value !== "string" || !/^[1-9]\d{0,18}$/.test(value)) throw new SessionError("session-tenant-invalid");
  return value;
}

function require_safe_id(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256
    || value.trim() !== value || /[\u0000-]/u.test(value)) throw new SessionError("session-id-invalid");
  return value;
}
