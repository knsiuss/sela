/** Explicit audited repair and quarantine actions for orphaned inbound claims. */

import type { SqlClient, SqlQueryResult } from "../persistence/sql_client.js";
import type { IngressReconciliationStatus } from "./reconciliation.js";
import { IngressReconciliationError } from "./reconciliation.js";

/** Operator action that resolves one orphan; deletion is deliberately absent. */
export type IngressRepairAction = "requeue" | "quarantine" | "dead_letter" | "mark_repaired";

/** One audited repair with actor, reason, timestamp, and resulting state. */
export interface IngressRepairRecord {
  /** Owning tenant. */
  tenant_id: string;
  /** Stable provider message id. */
  wamid: string;
  /** Explicit operator action. */
  action: IngressRepairAction;
  /** Operator subject that authorized the repair. */
  actor: string;
  /** Human-readable reason, 8 to 512 characters. */
  reason: string;
  /** Lifecycle state after the repair. */
  resulting_state: IngressReconciliationStatus;
  /** ISO instant the repair was recorded. */
  created_at: string;
}

/** Repair input before the server assigns its timestamp. */
export type NewIngressRepair = Omit<IngressRepairRecord, "created_at">;

/** Narrow port for the explicit repair command boundary. */
export interface IngressRepairRecorder {
  /**
   * Record one audited repair without deleting any claim.
   *
   * @param repair - Validated repair input; timestamp is server-assigned.
   * @returns The persisted repair record.
   */
  record_repair(repair: NewIngressRepair): Promise<IngressRepairRecord>;
}

const INSERT_REPAIR_SQL = `
  INSERT INTO ingress_repairs (
    tenant_id, wamid, action, actor, reason, resulting_state, created_at
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7)
  RETURNING tenant_id, wamid, action, actor, reason, resulting_state, created_at
`;

/** Parameterized Postgres recorder for audited repairs. */
export class PostgresIngressRepairRecorder implements IngressRepairRecorder {
  private readonly sql_client: SqlClient;
  private readonly clock: () => Date;

  /**
   * Create a recorder over the server-side SQL boundary.
   *
   * @param sql_client - Server-side SQL boundary.
   * @param clock - Injected clock for deterministic timestamps.
   */
  constructor(sql_client: SqlClient, clock: () => Date = () => new Date()) {
    this.sql_client = sql_client;
    this.clock = clock;
  }

  /**
   * Insert one audited repair row with a server-assigned timestamp.
   *
   * @param repair - Validated actor, reason, action, and resulting state.
   * @returns The persisted repair record.
   */
  async record_repair(repair: NewIngressRepair): Promise<IngressRepairRecord> {
    const record = validate_repair(repair, valid_now(this.clock()));
    try {
      const result = await this.sql_client.query(INSERT_REPAIR_SQL, [
        record.tenant_id,
        record.wamid,
        record.action,
        record.actor,
        record.reason,
        record.resulting_state,
        record.created_at,
      ]);
      return normalize_repair_row(result);
    } catch (error) {
      if (error instanceof IngressReconciliationError) throw error;
      throw new IngressReconciliationError("ingress-repair-failed", error);
    }
  }
}

/** In-memory recorder for unit tests and explicit local composition. */
export class InMemoryIngressRepairRecorder implements IngressRepairRecorder {
  private readonly repairs: IngressRepairRecord[] = [];
  private readonly clock: () => Date;

  /**
   * Create an in-memory recorder.
   *
   * @param clock - Injected clock for deterministic timestamps.
   */
  constructor(clock: () => Date = () => new Date()) {
    this.clock = clock;
  }

  /**
   * Append one validated repair with a server-assigned timestamp.
   *
   * @param repair - Validated repair input.
   * @returns A defensive copy of the recorded repair.
   */
  async record_repair(repair: NewIngressRepair): Promise<IngressRepairRecord> {
    const record = validate_repair(repair, valid_now(this.clock()));
    this.repairs.push({ ...record });
    return { ...record };
  }

  /**
   * Read recorded repairs for assertions.
   *
   * @returns Defensive copies in insertion order.
   */
  all(): IngressRepairRecord[] {
    return this.repairs.map((repair) => ({ ...repair }));
  }
}

/**
 * Validate one repair before persistence; deletion can never validate.
 *
 * @param repair - Operator-supplied repair input.
 * @param now - Server instant assigned as the record timestamp.
 * @returns The complete repair record.
 * @throws IngressReconciliationError on any invalid field.
 */
export function validate_repair(repair: NewIngressRepair, now: Date): IngressRepairRecord {
  if (typeof repair !== "object" || repair === null) {
    throw new IngressReconciliationError("ingress-repair-invalid");
  }
  return {
    tenant_id: require_id(repair.tenant_id, "tenant_id"),
    wamid: require_wamid(repair.wamid),
    action: require_action(repair.action),
    actor: require_actor(repair.actor),
    reason: require_reason(repair.reason),
    resulting_state: require_status(repair.resulting_state),
    created_at: now.toISOString(),
  };
}

function require_action(value: unknown): IngressRepairAction {
  if (
    value !== "requeue" &&
    value !== "quarantine" &&
    value !== "dead_letter" &&
    value !== "mark_repaired"
  ) {
    throw new IngressReconciliationError("ingress-repair-action-invalid");
  }
  return value;
}

function require_actor(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 128) {
    throw new IngressReconciliationError("ingress-repair-actor-invalid");
  }
  return value;
}

function require_reason(value: unknown): string {
  if (typeof value !== "string" || value.trim().length < 8 || value.length > 512) {
    throw new IngressReconciliationError("ingress-repair-reason-invalid");
  }
  return value;
}

function require_status(value: unknown): IngressReconciliationStatus {
  if (
    value !== "accepted" &&
    value !== "duplicate" &&
    value !== "reconciling" &&
    value !== "needs_repair" &&
    value !== "failed"
  ) {
    throw new IngressReconciliationError("ingress-repair-status-invalid");
  }
  return value;
}

function require_id(value: unknown, field_name: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 256) {
    throw new IngressReconciliationError(`ingress-${field_name}-invalid`);
  }
  return String(value);
}

function require_wamid(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 128) {
    throw new IngressReconciliationError("ingress-wamid-invalid");
  }
  return value;
}

function valid_now(now: Date): Date {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new IngressReconciliationError("ingress-clock-invalid");
  }
  return now;
}

function normalize_repair_row(result: SqlQueryResult): IngressRepairRecord {
  if (!Array.isArray(result.rows) || result.rows.length !== 1) {
    throw new IngressReconciliationError("ingress-repair-result-invalid");
  }
  const row = result.rows[0];
  if (typeof row !== "object" || row === null) {
    throw new IngressReconciliationError("ingress-repair-row-invalid");
  }
  const record = row as Record<string, unknown>;
  const action = record["action"];
  const resulting_state = record["resulting_state"];
  if (action === undefined || resulting_state === undefined) {
    throw new IngressReconciliationError("ingress-repair-row-invalid");
  }
  return validate_repair(
    {
      tenant_id: string_value(record["tenant_id"]),
      wamid: string_value(record["wamid"]),
      action: action as IngressRepairAction,
      actor: string_value(record["actor"]),
      reason: string_value(record["reason"]),
      resulting_state: resulting_state as IngressReconciliationStatus,
    },
    new Date(timestamp_value(record["created_at"])),
  );
}

function string_value(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  throw new IngressReconciliationError("ingress-repair-row-invalid");
}

function timestamp_value(value: unknown): string {
  const text = string_value(value);
  if (!Number.isFinite(Date.parse(text))) throw new IngressReconciliationError("ingress-repair-row-invalid");
  return text;
}
