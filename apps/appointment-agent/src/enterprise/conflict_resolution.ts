/** Conflict-resolution state machine for operator-mediated reschedules. */

import { authorize, type AuthenticatedPrincipal } from "./authorization.js";

/** Conflict lifecycle; accepted, rejected, and expired are terminal. */
export type ConflictStatus = "pending" | "proposed" | "accepted" | "rejected" | "expired";

/** One tenant-scoped scheduling conflict. */
export interface ConflictRecord {
  conflict_id: string;
  tenant_id: string;
  appointment_id: string;
  status: ConflictStatus;
  generation: number;
  proposed_slot_iso: string | null;
  expires_at_iso: string;
  decided_at_iso: string | null;
  updated_at_iso: string;
}

/** Input for opening a conflict. */
export interface OpenConflictInput {
  conflict_id: string;
  tenant_id: string;
  appointment_id: string;
  generation: number;
  ttl_minutes?: number;
  clock?: () => Date;
}

/** Failure with a stable machine-readable code. */
export class ConflictError extends Error {
  readonly code: string;

  /** Create a sanitized conflict failure. */
  constructor(code: string) {
    super(code);
    this.name = "ConflictError";
    this.code = code;
  }
}

/**
 * Open a conflict in pending status.
 *
 * @param input - Conflict identifiers and generation.
 * @returns New pending record.
 */
export function open_conflict(input: OpenConflictInput): ConflictRecord {
  if (typeof input !== "object" || input === null) throw new ConflictError("conflict-invalid");
  const conflict_id = require_safe_id(input.conflict_id);
  require_tenant_id(input.tenant_id);
  const appointment_id = require_safe_id(input.appointment_id);
  if (!Number.isSafeInteger(input.generation) || input.generation < 0) throw new ConflictError("conflict-generation-invalid");
  const ttl = input.ttl_minutes ?? 60;
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 10_080) throw new ConflictError("conflict-ttl-invalid");
  const now_ms = (input.clock ?? (() => new Date()))().getTime();
  const now = new Date(now_ms).toISOString();
  return {
    conflict_id, tenant_id: input.tenant_id, appointment_id, status: "pending",
    generation: input.generation, proposed_slot_iso: null,
    expires_at_iso: new Date(now_ms + ttl * 60_000).toISOString(),
    decided_at_iso: null, updated_at_iso: now,
  };
}

/**
 * Propose a resolution slot for a pending conflict.
 *
 * @param record - Current record.
 * @param proposed_slot_iso - Candidate slot.
 * @param principal - Acting principal with appointments:reschedule.
 * @param tenant_id - Owning tenant.
 * @returns Record in proposed status.
 */
export function propose_resolution(
  record: ConflictRecord,
  proposed_slot_iso: string,
  principal: AuthenticatedPrincipal,
  tenant_id: string,
): ConflictRecord {
  const current = require_record(record);
  authorize(principal, tenant_id, "appointments:reschedule");
  require_scope(current, tenant_id);
  if (current.status !== "pending") throw new ConflictError(`conflict-propose-illegal-from-${current.status}`);
  if (!Number.isFinite(Date.parse(proposed_slot_iso))) throw new ConflictError("conflict-slot-invalid");
  return { ...current, status: "proposed", proposed_slot_iso, updated_at_iso: new Date().toISOString() };
}

/**
 * Accept a proposed resolution; requires MFA beyond base RBAC.
 *
 * appointments:reschedule is not MFA-gated in the base RBAC, but accepting a
 * conflict performs a calendar-changing decision, so MFA is required here.
 *
 * @param record - Current record.
 * @param principal - Acting principal with MFA.
 * @param tenant_id - Owning tenant.
 * @param generation - Expected generation; stale generations are rejected.
 * @returns Record in accepted status.
 */
export function accept_resolution(
  record: ConflictRecord,
  principal: AuthenticatedPrincipal,
  tenant_id: string,
  generation: number,
): ConflictRecord {
  const current = require_record(record);
  authorize(principal, tenant_id, "appointments:reschedule");
  require_scope(current, tenant_id);
  if (!principal.has_mfa) throw new ConflictError("conflict-mfa-required");
  if (current.status !== "proposed") throw new ConflictError(`conflict-accept-illegal-from-${current.status}`);
  if (generation !== current.generation) throw new ConflictError("conflict-generation-stale");
  const now = new Date().toISOString();
  return { ...current, status: "accepted", decided_at_iso: now, updated_at_iso: now };
}

/**
 * Reject a proposed or pending conflict.
 *
 * @param record - Current record.
 * @param principal - Acting principal with appointments:reschedule.
 * @param tenant_id - Owning tenant.
 * @returns Record in rejected status.
 */
export function reject_resolution(
  record: ConflictRecord,
  principal: AuthenticatedPrincipal,
  tenant_id: string,
): ConflictRecord {
  const current = require_record(record);
  authorize(principal, tenant_id, "appointments:reschedule");
  require_scope(current, tenant_id);
  if (current.status !== "pending" && current.status !== "proposed") {
    throw new ConflictError(`conflict-reject-illegal-from-${current.status}`);
  }
  const now = new Date().toISOString();
  return { ...current, status: "rejected", decided_at_iso: now, updated_at_iso: now };
}

/**
 * Expire a pending or proposed conflict past its deadline.
 *
 * @param record - Current record.
 * @param now - Reference time.
 * @returns Expired record, or the input when not yet due.
 */
export function expire_conflict(record: ConflictRecord, now: Date = new Date()): ConflictRecord {
  const current = require_record(record);
  if (current.status !== "pending" && current.status !== "proposed") return current;
  if (Date.parse(current.expires_at_iso) > now.getTime()) return current;
  const at = now.toISOString();
  return { ...current, status: "expired", decided_at_iso: at, updated_at_iso: at };
}

/** In-memory conflict adapter for tests and explicit local mode. */
export class InMemoryConflictStore {
  private readonly rows = new Map<string, ConflictRecord>();

  /**
   * Persist a record.
   *
   * @param record - Record to store.
   */
  async save(record: ConflictRecord): Promise<void> {
    this.rows.set(require_record(record).conflict_id, { ...record });
  }

  /**
   * Read one record.
   *
   * @param conflict_id - Conflict identifier.
   * @returns A copy or null.
   */
  async get(conflict_id: string): Promise<ConflictRecord | null> {
    const found = this.rows.get(conflict_id);
    return found === undefined ? null : { ...found };
  }
}

function require_record(value: ConflictRecord): ConflictRecord {
  if (typeof value !== "object" || value === null) throw new ConflictError("conflict-invalid");
  require_safe_id(value.conflict_id);
  require_tenant_id(value.tenant_id);
  require_safe_id(value.appointment_id);
  if (!is_status(value.status)) throw new ConflictError("conflict-status-invalid");
  if (!Number.isSafeInteger(value.generation) || value.generation < 0) throw new ConflictError("conflict-generation-invalid");
  return value;
}

function is_status(value: unknown): value is ConflictStatus {
  return value === "pending" || value === "proposed" || value === "accepted"
    || value === "rejected" || value === "expired";
}

function require_scope(record: ConflictRecord, tenant_id: string): void {
  require_tenant_id(tenant_id);
  if (record.tenant_id !== tenant_id) throw new ConflictError("conflict-tenant-mismatch");
}

function require_tenant_id(value: string): string {
  if (typeof value !== "string" || !/^[1-9]\d{0,18}$/.test(value)) throw new ConflictError("conflict-tenant-invalid");
  return value;
}

function require_safe_id(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256
    || value.trim() !== value || /[\u0000-]/u.test(value)) throw new ConflictError("conflict-id-invalid");
  return value;
}
