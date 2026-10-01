/** PII-minimal audit boundary for reschedules rejected before calendar access. */

import type { SqlClient } from "../persistence/sql_client.js";

/** Sanitized reasons that can be persisted before a calendar operation exists. */
export type RescheduleRejectionReason =
  | "appointment_context_missing"
  | "appointment_context_changed"
  | "appointment_not_found_or_wrong_tenant"
  | "appointment_not_reschedulable"
  | "intent_context_mismatch";

/** One rejected reschedule request with no message or recipient content. */
export interface RescheduleRejection {
  tenant_id: string;
  conversation_id: string;
  appointment_id?: string;
  reason: RescheduleRejectionReason;
}

/** Narrow append-only audit port used by the reschedule state machine. */
export interface RescheduleAudit {
  /** Record one rejected request without changing business state. */
  record_rejection(input: RescheduleRejection): Promise<void>;
}

/** Sanitized audit persistence failure. */
export class RescheduleAuditError extends Error {
  /** Create a safe audit error. */
  constructor(reason = "reschedule-audit-failed", cause?: unknown) {
    super(reason, cause === undefined ? undefined : { cause });
    this.name = "RescheduleAuditError";
  }
}

const INSERT_REJECTION_SQL = `
  INSERT INTO audit_log (tenant_id, actor, action, entity_type, entity_id, diff)
  VALUES ($1, 'appointment-agent', 'reschedule_rejected', 'appointment', $2, $3::jsonb)
`;

/** Parameterized Postgres audit adapter. */
export class PostgresRescheduleAudit implements RescheduleAudit {
  private readonly sql_client: SqlClient;

  /** Create the adapter over the server-side SQL boundary. */
  constructor(sql_client: SqlClient) {
    this.sql_client = sql_client;
  }

  /** Append one PII-minimal rejected reschedule event. */
  async record_rejection(input: RescheduleRejection): Promise<void> {
    const tenant_id = validate_id(input.tenant_id, "tenant_id", 32);
    const conversation_id = validate_id(input.conversation_id, "conversation_id", 128);
    const appointment_id = input.appointment_id === undefined
      ? undefined
      : validate_id(input.appointment_id, "appointment_id", 64);
    try {
      await this.sql_client.query(INSERT_REJECTION_SQL, [
        tenant_id,
        appointment_id ?? `conversation:${conversation_id}`,
        JSON.stringify({
          reason: input.reason,
          conversation_id,
          ...(appointment_id === undefined ? {} : { appointment_id }),
        }),
      ]);
    } catch (error) {
      throw new RescheduleAuditError("reschedule-rejection-audit-failed", error);
    }
  }
}

/** Explicit in-memory audit adapter for local composition and tests. */
export class InMemoryRescheduleAudit implements RescheduleAudit {
  readonly rejections: RescheduleRejection[] = [];

  /** Append one bounded in-memory rejection record. */
  async record_rejection(input: RescheduleRejection): Promise<void> {
    this.rejections.push({ ...input });
  }
}

function validate_id(value: string, field_name: string, max_length: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max_length) {
    throw new RescheduleAuditError(`reschedule-audit-${field_name}-invalid`);
  }
  return value;
}
