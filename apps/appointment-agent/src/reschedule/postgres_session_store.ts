/** Parameterized Postgres adapter for tenant-scoped reschedule sessions. */

import type { SqlClient, SqlQueryResult } from "../persistence/sql_client.js";
import {
  MAX_RESCHEDULE_SESSION_COUNTER,
  parse_reschedule_session,
  parse_reschedule_session_state,
  RescheduleSessionValidationError,
  type RescheduleSession,
  type RescheduleSessionState,
} from "./session_model.js";
import {
  RescheduleSessionStoreError,
  validate_reschedule_session_scope,
  type RescheduleSessionScope,
  type RescheduleSessionStore,
} from "./session_store.js";

const LOAD_SESSION_SQL = `
  SELECT tenant_id, conversation_id, phase, candidate_slots, chosen_slot_id,
         hold_id, hold_expires_at_iso, offer_generation, last_wamid, version,
         expires_at, created_at, updated_at
  FROM reschedule_sessions
  WHERE tenant_id = $1
    AND conversation_id = $2
    AND expires_at > now()
  LIMIT 1
`;

const CREATE_SESSION_SQL = `
  INSERT INTO reschedule_sessions (
    tenant_id, conversation_id, phase, candidate_slots, chosen_slot_id,
    hold_id, hold_expires_at_iso, offer_generation, last_wamid,
    expires_at, version, created_at, updated_at
  )
  VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, 1, now(), now())
  ON CONFLICT (tenant_id, conversation_id) DO UPDATE
  SET phase = EXCLUDED.phase,
      candidate_slots = EXCLUDED.candidate_slots,
      chosen_slot_id = EXCLUDED.chosen_slot_id,
      hold_id = EXCLUDED.hold_id,
      hold_expires_at_iso = EXCLUDED.hold_expires_at_iso,
      offer_generation = EXCLUDED.offer_generation,
      last_wamid = EXCLUDED.last_wamid,
      expires_at = EXCLUDED.expires_at,
      version = 1,
      created_at = now(),
      updated_at = now()
  WHERE reschedule_sessions.expires_at <= now()
  RETURNING tenant_id, conversation_id, phase, candidate_slots, chosen_slot_id,
            hold_id, hold_expires_at_iso, offer_generation, last_wamid, version,
            expires_at, created_at, updated_at
`;

const UPDATE_SESSION_SQL = `
  UPDATE reschedule_sessions
  SET phase = $3,
      candidate_slots = $4::jsonb,
      chosen_slot_id = $5,
      hold_id = $6,
      hold_expires_at_iso = $7,
      offer_generation = $8,
      last_wamid = $9,
      expires_at = $10,
      version = version + 1,
      updated_at = now()
  WHERE tenant_id = $1
    AND conversation_id = $2
    AND version = $11
    AND expires_at > now()
  RETURNING tenant_id, conversation_id, phase, candidate_slots, chosen_slot_id,
            hold_id, hold_expires_at_iso, offer_generation, last_wamid, version,
            expires_at, created_at, updated_at
`;

/** Optional clock injection for deterministic expiry checks in tests. */
export interface PostgresRescheduleSessionStoreOptions {
  clock?: () => Date;
}

/** Postgres implementation of the narrow reschedule-session store port. */
export class PostgresRescheduleSessionStore implements RescheduleSessionStore {
  private readonly sql_client: SqlClient;
  private readonly clock: () => Date;

  /** Create a store over the application's parameterized SQL boundary. */
  constructor(
    sql_client: SqlClient,
    options: PostgresRescheduleSessionStoreOptions = {},
  ) {
    this.sql_client = sql_client;
    this.clock = options.clock ?? (() => new Date());
  }

  /** Load one unexpired session using the compound tenant/conversation key. */
  async load(scope: RescheduleSessionScope): Promise<RescheduleSession | null> {
    const normalized_scope = validate_reschedule_session_scope(scope);
    try {
      const result = await this.sql_client.query(LOAD_SESSION_SQL, [
        normalized_scope.tenant_id,
        normalized_scope.conversation_id,
      ]);
      return first_session(result);
    } catch (error) {
      throw translate_store_error("reschedule-session-read-failed", error);
    }
  }

  /** Insert/replace expired state or compare-and-swap an exact live version. */
  async commit(
    scope: RescheduleSessionScope,
    state: RescheduleSessionState,
    expected_version: number | null,
  ): Promise<RescheduleSession | null> {
    const normalized_scope = validate_reschedule_session_scope(scope);
    const normalized_state = valid_state(state);
    const now = valid_now(this.clock());
    if (Date.parse(normalized_state.expires_at_iso) <= now.getTime()) {
      throw new RescheduleSessionStoreError("reschedule-session-expires-at-invalid");
    }
    if (
      expected_version !== null
      && (!Number.isSafeInteger(expected_version)
        || expected_version < 1
        || expected_version >= MAX_RESCHEDULE_SESSION_COUNTER)
    ) {
      throw new RescheduleSessionStoreError("reschedule-session-version-invalid");
    }
    const values = commit_values(normalized_scope, normalized_state);
    try {
      const result = expected_version === null
        ? await this.sql_client.query(CREATE_SESSION_SQL, values)
        : await this.sql_client.query(UPDATE_SESSION_SQL, [...values, expected_version]);
      return first_session(result);
    } catch (error) {
      throw translate_store_error("reschedule-session-write-failed", error);
    }
  }
}

function commit_values(
  scope: RescheduleSessionScope,
  state: RescheduleSessionState,
): unknown[] {
  return [
    scope.tenant_id,
    scope.conversation_id,
    state.phase,
    JSON.stringify(state.candidate_slots),
    state.chosen_slot_id,
    state.hold_id,
    state.hold_expires_at_iso,
    state.offer_generation,
    state.last_wamid,
    state.expires_at_iso,
  ];
}

function first_session(result: SqlQueryResult): RescheduleSession | null {
  if (!Array.isArray(result.rows)) {
    throw new RescheduleSessionStoreError("reschedule-session-result-invalid");
  }
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  if (typeof row !== "object" || row === null) {
    throw new RescheduleSessionStoreError("reschedule-session-row-invalid");
  }
  return normalize_session(row as Record<string, unknown>);
}

function normalize_session(row: Record<string, unknown>): RescheduleSession {
  try {
    return parse_reschedule_session({
      tenant_id: required_string(row["tenant_id"], "tenant_id"),
      conversation_id: required_string(row["conversation_id"], "conversation_id"),
      phase: row["phase"],
      candidate_slots: parse_slots(row["candidate_slots"]),
      chosen_slot_id: nullable_string(row["chosen_slot_id"], "chosen_slot_id"),
      hold_id: nullable_string(row["hold_id"], "hold_id"),
      hold_expires_at_iso: nullable_timestamp(row["hold_expires_at_iso"], "hold_expires_at_iso"),
      offer_generation: required_integer(row["offer_generation"], "offer_generation"),
      last_wamid: nullable_string(row["last_wamid"], "last_wamid"),
      version: required_integer(row["version"], "version"),
      expires_at_iso: required_timestamp(row["expires_at"]),
      created_at_iso: required_timestamp(row["created_at"]),
      updated_at_iso: required_timestamp(row["updated_at"]),
    });
  } catch (error) {
    if (error instanceof RescheduleSessionStoreError) throw error;
    throw new RescheduleSessionStoreError("reschedule-session-row-invalid", error);
  }
}

function parse_slots(value: unknown): unknown {
  if (typeof value === "string") return JSON.parse(value) as unknown;
  return value;
}

function valid_state(state: RescheduleSessionState): RescheduleSessionState {
  try {
    return parse_reschedule_session_state(state);
  } catch (error) {
    if (error instanceof RescheduleSessionValidationError) {
      throw new RescheduleSessionStoreError("reschedule-session-state-invalid", error);
    }
    throw error;
  }
}

function required_string(value: unknown, field_name: string): string {
  if (
    (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint")
    || String(value).trim() === ""
  ) {
    throw new RescheduleSessionStoreError(`reschedule-session-${field_name}-invalid`);
  }
  return String(value);
}

function nullable_string(value: unknown, field_name: string): string | null {
  return value === null || value === undefined ? null : required_string(value, field_name);
}

function required_integer(value: unknown, field_name: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new RescheduleSessionStoreError(`reschedule-session-${field_name}-invalid`);
  }
  return parsed;
}

function required_timestamp(value: unknown): string {
  if (value instanceof Date) return valid_timestamp(value.toISOString());
  if (typeof value === "string" || typeof value === "number") return valid_timestamp(String(value));
  throw new RescheduleSessionStoreError("reschedule-session-timestamp-invalid");
}

function nullable_timestamp(value: unknown, field_name: string): string | null {
  if (value === null || value === undefined) return null;
  try {
    return required_timestamp(value);
  } catch (error) {
    throw new RescheduleSessionStoreError(`reschedule-session-${field_name}-invalid`, error);
  }
}

function valid_timestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new RescheduleSessionStoreError("reschedule-session-timestamp-invalid");
  }
  return new Date(Date.parse(value)).toISOString();
}

function valid_now(now: Date): Date {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new RescheduleSessionStoreError("reschedule-session-clock-invalid");
  }
  return now;
}

function translate_store_error(reason: string, error: unknown): RescheduleSessionStoreError {
  return error instanceof RescheduleSessionStoreError
    ? error
    : new RescheduleSessionStoreError(reason, error);
}
