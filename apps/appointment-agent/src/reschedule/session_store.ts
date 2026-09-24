/** Narrow persistence port and process-local adapter for reschedule sessions. */

import {
  MAX_RESCHEDULE_SESSION_COUNTER,
  parse_reschedule_session,
  parse_reschedule_session_state,
  type RescheduleSession,
  type RescheduleSessionState,
} from "./session_model.js";

/** Unique tenant/conversation scope for one reschedule flow. */
export interface RescheduleSessionScope {
  tenant_id: string;
  conversation_id: string;
}

/** Optimistic persistence boundary for PII-minimal button-flow state. */
export interface RescheduleSessionStore {
  /** Load one unexpired session inside its tenant/conversation scope. */
  load(scope: RescheduleSessionScope): Promise<RescheduleSession | null>;
  /**
   * Create or compare-and-swap one session.
   *
   * A null expected version creates or replaces an already expired row. A
   * numeric version updates only that exact version. Null is returned for a
   * duplicate live create or stale writer.
   */
  commit(
    scope: RescheduleSessionScope,
    state: RescheduleSessionState,
    expected_version: number | null,
  ): Promise<RescheduleSession | null>;
}

/** Sanitized failure at the session persistence boundary. */
export class RescheduleSessionStoreError extends Error {
  /** Create a safe persistence error. */
  constructor(reason = "reschedule-session-store-failed", cause?: unknown) {
    super(reason, cause === undefined ? undefined : { cause });
    this.name = "RescheduleSessionStoreError";
  }
}

/** Options controlling deterministic in-memory timestamps. */
export interface InMemoryRescheduleSessionStoreOptions {
  clock?: () => Date;
}

/** Process-local store used by explicit local/test composition. */
export class InMemoryRescheduleSessionStore implements RescheduleSessionStore {
  private readonly rows = new Map<string, RescheduleSession>();
  private readonly clock: () => Date;

  /** Create an isolated process-local session store. */
  constructor(options: InMemoryRescheduleSessionStoreOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
  }

  /**
   * Return defensive copies for focused test assertions.
   *
   * @returns Current unexpired sessions in insertion order.
   */
  async all(): Promise<RescheduleSession[]> {
    const now = valid_now(this.clock());
    return [...this.rows.values()]
      .filter((session) => Date.parse(session.expires_at_iso) > now.getTime())
      .map(copy_session);
  }

  /** Load one live session by tenant and conversation. */
  async load(scope: RescheduleSessionScope): Promise<RescheduleSession | null> {
    const key = valid_scope_key(scope);
    const now = valid_now(this.clock());
    const session = this.rows.get(key);
    if (session === undefined) return null;
    if (Date.parse(session.expires_at_iso) <= now.getTime()) {
      this.rows.delete(key);
      return null;
    }
    return copy_session(session);
  }

  /** Create or compare-and-swap one validated session snapshot. */
  async commit(
    scope: RescheduleSessionScope,
    state: RescheduleSessionState,
    expected_version: number | null,
  ): Promise<RescheduleSession | null> {
    const key = valid_scope_key(scope);
    const normalized = valid_state(state);
    const now = valid_now(this.clock());
    if (Date.parse(normalized.expires_at_iso) <= now.getTime()) {
      throw new RescheduleSessionStoreError("reschedule-session-expires-at-invalid");
    }
    const current = this.rows.get(key);
    if (expected_version === null) {
      if (current !== undefined && Date.parse(current.expires_at_iso) > now.getTime()) return null;
      if (current !== undefined) this.rows.delete(key);
      return this.insert(scope, normalized, now);
    }
    next_version(expected_version);
    if (current === undefined || current.version !== expected_version) return null;
    if (Date.parse(current.expires_at_iso) <= now.getTime()) {
      this.rows.delete(key);
      return null;
    }
    const next = parse_or_throw({
      ...scope,
      ...normalized,
      version: next_version(expected_version),
      created_at_iso: current.created_at_iso,
      updated_at_iso: now.toISOString(),
    });
    this.rows.set(key, next);
    return copy_session(next);
  }

  private insert(
    scope: RescheduleSessionScope,
    state: RescheduleSessionState,
    now: Date,
  ): RescheduleSession {
    const timestamp = now.toISOString();
    const session = parse_or_throw({
      ...scope,
      ...state,
      version: 1,
      created_at_iso: timestamp,
      updated_at_iso: timestamp,
    });
    this.rows.set(valid_scope_key(scope), session);
    return copy_session(session);
  }
}

function valid_scope_key(scope: RescheduleSessionScope): string {
  const normalized = validate_reschedule_session_scope(scope);
  return `${normalized.tenant_id}\u0000${normalized.conversation_id}`;
}

/**
 * Validate a tenant/conversation compound key.
 *
 * @param scope - Untrusted or composed session scope.
 * @returns The same scope after boundary validation.
 * @throws RescheduleSessionStoreError when either key is invalid.
 */
export function validate_reschedule_session_scope(scope: RescheduleSessionScope): RescheduleSessionScope {
  if (typeof scope.tenant_id !== "string" || scope.tenant_id.trim() === "" || scope.tenant_id.length > 256) {
    throw new RescheduleSessionStoreError("reschedule-session-tenant_id-invalid");
  }
  if (
    typeof scope.conversation_id !== "string"
    || scope.conversation_id.trim() === ""
    || scope.conversation_id.length > 128
  ) {
    throw new RescheduleSessionStoreError("reschedule-session-conversation_id-invalid");
  }
  return scope;
}

function valid_state(state: RescheduleSessionState): RescheduleSessionState {
  try {
    return parse_reschedule_session_state(state);
  } catch (error) {
    throw new RescheduleSessionStoreError("reschedule-session-state-invalid", error);
  }
}

function valid_now(now: Date): Date {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new RescheduleSessionStoreError("reschedule-session-clock-invalid");
  }
  return now;
}

function next_version(version: number): number {
  if (!Number.isSafeInteger(version) || version < 1 || version >= MAX_RESCHEDULE_SESSION_COUNTER) {
    throw new RescheduleSessionStoreError("reschedule-session-version-invalid");
  }
  return version + 1;
}

function parse_or_throw(value: unknown): RescheduleSession {
  try {
    return parse_reschedule_session(value);
  } catch (error) {
    throw new RescheduleSessionStoreError("reschedule-session-row-invalid", error);
  }
}

function copy_session(session: RescheduleSession): RescheduleSession {
  return parse_or_throw({
    ...session,
    candidate_slots: session.candidate_slots.map((slot) => ({ ...slot })),
  });
}
