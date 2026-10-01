/** Durable tenant-scoped Postgres calendar and atomic reschedule writer. */

import type { SlotHold, TimeSlot } from "../state.js";
import type {
  SqlTransactionClient,
  TransactionalSqlClient,
} from "../persistence/sql_client.js";
import { clamp_hold_ttl_seconds } from "../tools/hold_ttl.js";
import {
  AppointmentNotFoundError,
  AppointmentNotReschedulableError,
  AppointmentVersionConflictError,
  CalendarOperationConflictError,
  CalendarStoreError,
  HoldExpiredError,
  SlotUnavailableError,
  type CalendarPort,
  type RescheduleAppointmentCommand,
  type RescheduleAppointmentResult,
} from "../tools/calendar.js";
import {
  confirm_fingerprint,
  fingerprint,
  hold_customer_reference,
  hold_fingerprint,
  hold_operation_result_schema,
  new_appointment_id,
  public_reschedule_result,
  reschedule_operation_result_schema,
  validate_tenant_id,
  type DurableSlot,
  type ValidatedRescheduleCommand,
} from "./calendar_models.js";
import { CalendarOperationRunner } from "./calendar_operation_runner.js";
import {
  calendar_integer,
  calendar_row_string,
  calendar_slot_in_window,
  calendar_slot_overlaps,
  calendar_timestamp,
  first_calendar_row,
  map_calendar_slots,
  parse_calendar_blockers,
  parse_calendar_hold_row,
  require_calendar_row,
  safe_calendar_appointment_id,
  safe_calendar_operation_key,
  safe_calendar_text,
  safe_reschedule_command,
  valid_calendar_date,
  type CalendarHoldRow,
} from "./postgres_calendar_rows.js";
import {
  CANCEL_BOOKING_SQL,
  CONFIRM_HELD_APPOINTMENT_SQL,
  INSERT_AUDIT_SQL,
  INSERT_HELD_APPOINTMENT_SQL,
  INSERT_HOLD_SQL,
  INSERT_REJECTION_AUDIT_SQL,
  LIST_BLOCKERS_SQL,
  LOCK_HOLD_SQL,
  LOCK_SOURCE_APPOINTMENT_SQL,
  MARK_HELD_APPOINTMENT_RELEASED_SQL,
  MARK_HOLD_CONFIRMED_SQL,
  MARK_HOLD_EXPIRED_SQL,
  MARK_HOLD_RELEASED_SQL,
  MOVE_APPOINTMENT_SQL,
} from "./postgres_calendar_sql.js";

const MAX_DATABASE_VERSION = 2_147_483_647;

/** Construction inputs for one tenant's durable calendar writer. */
export interface PostgresCalendarWriterOptions {
  sql_client: TransactionalSqlClient;
  tenant_id: string;
  slots: readonly TimeSlot[];
  clock?: () => Date;
  appointment_id_factory?: () => string;
}

/** Postgres single writer for holds, confirmations, cancellations, and reschedules. */
export class PostgresCalendarWriter implements CalendarPort {
  private readonly sql_client: TransactionalSqlClient;
  private readonly tenant_id: string;
  private readonly slots: Map<string, DurableSlot>;
  private readonly operation_runner: CalendarOperationRunner;
  private readonly clock: () => Date;
  private readonly appointment_id_factory: () => string;

  /** Create a durable writer; every catalog slot must carry a stable resource id. */
  constructor(options: PostgresCalendarWriterOptions) {
    this.sql_client = options.sql_client;
    this.tenant_id = validate_tenant_id(options.tenant_id);
    this.slots = map_calendar_slots(options.slots);
    this.operation_runner = new CalendarOperationRunner({
      sql_client: options.sql_client,
      tenant_id: this.tenant_id,
    });
    this.clock = options.clock ?? (() => new Date());
    this.appointment_id_factory = options.appointment_id_factory ?? new_appointment_id;
  }

  /** List catalog slots not covered by a durable held or confirmed appointment. */
  async list_slots(window_start_iso: string, window_end_iso: string): Promise<TimeSlot[]> {
    const starts_at_ms = calendar_timestamp(window_start_iso, "window_start_iso");
    const ends_at_ms = calendar_timestamp(window_end_iso, "window_end_iso");
    if (ends_at_ms <= starts_at_ms) throw new RangeError("availability window must have positive duration");
    try {
      const result = await this.sql_client.query(LIST_BLOCKERS_SQL, [
        this.tenant_id,
        new Date(starts_at_ms).toISOString(),
        new Date(ends_at_ms).toISOString(),
      ]);
      const blockers = parse_calendar_blockers(result);
      return [...this.slots.values()]
        .filter((slot) => calendar_slot_in_window(slot, starts_at_ms, ends_at_ms))
        .filter((slot) => !blockers.some((blocker) => calendar_slot_overlaps(slot, blocker)))
        .map(({ resource_id: _resource_id, ...slot }) => ({ ...slot }));
    } catch (error) {
      throw translate_error(error, "availability-query-failed", "availability");
    }
  }

  /** Insert a durable held appointment and hold ledger under one operation key. */
  async hold_slot(
    slot_id: string,
    ttl_seconds: number,
    idempotency_key?: string,
  ): Promise<Pick<SlotHold, "hold_id" | "expires_at_iso">> {
    const slot = this.require_slot(slot_id);
    if (idempotency_key === undefined) throw new CalendarStoreError("calendar-operation-key-required");
    const operation_key = safe_calendar_operation_key(idempotency_key);
    const requested_ttl = clamp_hold_ttl_seconds(ttl_seconds);
    const request_fingerprint = hold_fingerprint({
      tenant_id: this.tenant_id,
      slot,
      ttl_seconds: requested_ttl,
      operation_key,
    });
    const expires_at_ms = this.clock().getTime() + requested_ttl * 1_000;
    const expires_at_iso = valid_calendar_date(expires_at_ms).toISOString();
    const held_appointment_id = safe_calendar_appointment_id(this.appointment_id_factory());
    const hold_id = fingerprint(["hold-id-v1", this.tenant_id, operation_key]).slice(0, 32);
    try {
      const result = await this.operation_runner.run("hold", operation_key, request_fingerprint, async (transaction) => {
        await require_calendar_row(transaction.query(INSERT_HELD_APPOINTMENT_SQL, [
          held_appointment_id,
          this.tenant_id,
          slot.resource_id,
          hold_customer_reference(this.tenant_id, operation_key),
          slot.start_iso,
          slot.end_iso,
          expires_at_iso,
          operation_key,
        ]), "held-appointment-insert-failed");
        await require_calendar_row(transaction.query(INSERT_HOLD_SQL, [
          this.tenant_id,
          slot.resource_id,
          slot.start_iso,
          slot.end_iso,
          hold_id,
          expires_at_iso,
          slot.id,
          operation_key,
          held_appointment_id,
        ]), "hold-insert-failed");
        await this.insert_audit(transaction, "hold_created", "appointment_hold", hold_id, {
          operation_type: "hold",
          slot_id: slot.id,
        });
        return hold_operation_result_schema.parse({
          operation_type: "hold",
          hold_id,
          held_appointment_id,
          slot_id: slot.id,
          expires_at_iso,
        });
      });
      return { hold_id: result.hold_id, expires_at_iso: result.expires_at_iso };
    } catch (error) {
      throw translate_error(error, "calendar-hold-write-failed", slot.id);
    }
  }

  /** Confirm a durable held appointment as a new booking under one operation key. */
  async confirm_hold(hold_id: string, idempotency_key: string): Promise<void> {
    const requested_hold_id = safe_calendar_text(hold_id, "hold_id");
    const operation_key = safe_calendar_operation_key(idempotency_key);
    const request_fingerprint = confirm_fingerprint({
      tenant_id: this.tenant_id,
      hold_id: requested_hold_id,
      operation_key,
    });
    try {
      await this.operation_runner.run("confirm", operation_key, request_fingerprint, async (transaction) => {
        const hold = await this.lock_live_hold(transaction, requested_hold_id);
        const appointment = await require_calendar_row(transaction.query(CONFIRM_HELD_APPOINTMENT_SQL, [
          this.tenant_id,
          hold.held_appointment_id,
        ]), "held-appointment-confirm-failed");
        const appointment_id = safe_calendar_appointment_id(calendar_row_string(appointment.appointment_id, "appointment_id"));
        await require_calendar_row(transaction.query(MARK_HOLD_CONFIRMED_SQL, [
          this.tenant_id,
          requested_hold_id,
          appointment_id,
        ]), "hold-confirm-failed");
        await this.insert_audit(transaction, "hold_confirmed", "appointment_hold", requested_hold_id, {
          operation_type: "confirm",
        });
        return {
          operation_type: "confirm" as const,
          hold_id: requested_hold_id,
          appointment_id,
        };
      });
    } catch (error) {
      throw translate_error(error, "calendar-confirm-failed", requested_hold_id);
    }
  }

  /** Atomically replace the source appointment with the live target hold. */
  async reschedule_appointment(command: RescheduleAppointmentCommand): Promise<RescheduleAppointmentResult> {
    const validated = safe_reschedule_command(command);
    if (validated.tenant_id !== this.tenant_id) {
      throw new AppointmentNotFoundError(validated.appointment_id);
    }
    try {
      const target = this.require_slot(validated.target_slot_id);
      const result = await this.operation_runner.run(
        "reschedule",
        validated.idempotency_key,
        validated.fingerprint,
        async (transaction) => this.commit_reschedule(transaction, validated, target),
      );
      return public_reschedule_result(result);
    } catch (error) {
      const translated = translate_error(error, "calendar-reschedule-failed", validated.target_slot_id);
      if (is_reschedule_rejection(translated)) {
        await this.record_rejection(translated, validated.appointment_id, validated.fingerprint);
      }
      throw translated;
    }
  }

  /** Release or expire a held claim idempotently without changing confirmed state. */
  async release_hold(hold_id: string): Promise<void> {
    const requested_hold_id = safe_calendar_text(hold_id, "hold_id");
    try {
      await this.sql_client.with_transaction(async (transaction) => {
        const hold = await this.load_hold(transaction, requested_hold_id);
        if (hold === null) return;
        if (hold.hold_status !== "held") {
          if (hold.held_status === "held") throw new CalendarStoreError("calendar-hold-state-inconsistent");
          return;
        }
        await require_calendar_row(transaction.query(MARK_HELD_APPOINTMENT_RELEASED_SQL, [
          this.tenant_id,
          hold.held_appointment_id,
        ]), "held-appointment-release-failed");
        const is_expired = !hold.is_live || hold.expires_at_ms <= this.clock().getTime();
        await require_calendar_row(transaction.query(is_expired ? MARK_HOLD_EXPIRED_SQL : MARK_HOLD_RELEASED_SQL, [
          this.tenant_id,
          requested_hold_id,
        ]), "hold-release-failed");
        await this.insert_audit(transaction, is_expired ? "hold_expired" : "hold_released", "appointment_hold", requested_hold_id, {
          operation_type: "release",
        });
      });
    } catch (error) {
      throw translate_error(error, "calendar-release-failed", requested_hold_id);
    }
  }

  /** Cancel one confirmed appointment idempotently inside this tenant. */
  async cancel_booking(booking_id: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(booking_id)) return;
    const appointment_id = safe_calendar_appointment_id(booking_id);
    try {
      await this.sql_client.query(CANCEL_BOOKING_SQL, [this.tenant_id, appointment_id]);
    } catch (error) {
      throw translate_error(error, "calendar-cancel-failed", appointment_id);
    }
  }

  private async commit_reschedule(
    transaction: SqlTransactionClient,
    command: ValidatedRescheduleCommand,
    target: DurableSlot,
  ) {
    const source_result = await transaction.query(LOCK_SOURCE_APPOINTMENT_SQL, [
      command.tenant_id,
      command.appointment_id,
    ]);
    const source = first_calendar_row(source_result);
    if (source === null) throw new AppointmentNotFoundError(command.appointment_id);
    const source_status = calendar_row_string(source.status, "appointment_status");
    const source_version = calendar_integer(source.version, "appointment_version");
    if (source_status !== "confirmed") throw new AppointmentNotReschedulableError(command.appointment_id);
    if (source_version !== command.expected_version) {
      throw new AppointmentVersionConflictError(command.appointment_id);
    }
    const hold = await this.lock_live_hold(transaction, command.hold_id);
    this.assert_target(hold, target);
    await require_calendar_row(transaction.query(MARK_HELD_APPOINTMENT_RELEASED_SQL, [
      command.tenant_id,
      hold.held_appointment_id,
    ]), "held-appointment-reschedule-failed");
    const moved = await require_calendar_row(transaction.query(MOVE_APPOINTMENT_SQL, [
      command.tenant_id,
      command.appointment_id,
      command.expected_version,
      target.resource_id,
      target.start_iso,
      target.end_iso,
    ]), "appointment-version-conflict");
    const next_version = calendar_integer(moved.version, "version");
    if (next_version !== command.expected_version + 1 || next_version > MAX_DATABASE_VERSION) {
      throw new CalendarStoreError("appointment-version-transition-invalid");
    }
    await require_calendar_row(transaction.query(MARK_HOLD_CONFIRMED_SQL, [
      command.tenant_id,
      command.hold_id,
      command.appointment_id,
    ]), "hold-reschedule-confirm-failed");
    await this.insert_audit(transaction, "appointment_rescheduled", "appointment", command.appointment_id, {
      previous_version: command.expected_version,
      version: next_version,
      hold_id: command.hold_id,
      target_slot_id: target.id,
    });
    return reschedule_operation_result_schema.parse({
      operation_type: "reschedule",
      appointment_id: command.appointment_id,
      previous_version: command.expected_version,
      version: next_version,
      hold_id: command.hold_id,
      target_slot_id: target.id,
      status: "confirmed",
    });
  }

  private assert_target(hold: CalendarHoldRow, target: DurableSlot): void {
    const start_ms = calendar_timestamp(target.start_iso, "target.start_iso");
    const end_ms = calendar_timestamp(target.end_iso, "target.end_iso");
    if (
      hold.slot_id !== target.id
      || hold.resource_id !== target.resource_id
      || hold.held_resource_id !== target.resource_id
      || hold.starts_at_ms !== start_ms
      || hold.ends_at_ms !== end_ms
      || hold.held_starts_at_ms !== start_ms
      || hold.held_ends_at_ms !== end_ms
    ) {
      throw new SlotUnavailableError(target.id);
    }
  }

  private async lock_live_hold(transaction: SqlTransactionClient, hold_id: string): Promise<CalendarHoldRow> {
    const hold = await this.load_hold(transaction, hold_id);
    if (
      hold === null
      || hold.hold_status !== "held"
      || hold.held_status !== "held"
      || !hold.is_live
    ) {
      throw new HoldExpiredError(hold_id);
    }
    if (hold.expires_at_ms <= this.clock().getTime()) throw new HoldExpiredError(hold_id);
    return hold;
  }

  private async load_hold(transaction: SqlTransactionClient, hold_id: string): Promise<CalendarHoldRow | null> {
    const result = await transaction.query(LOCK_HOLD_SQL, [this.tenant_id, hold_id]);
    if (!Array.isArray(result.rows)) throw new CalendarStoreError("calendar-result-invalid");
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (typeof row !== "object" || row === null) throw new CalendarStoreError("calendar-row-invalid");
    return parse_calendar_hold_row(row as Record<string, unknown>);
  }

  private async insert_audit(
    transaction: SqlTransactionClient,
    action: string,
    entity_type: string,
    entity_id: string,
    diff: Record<string, unknown>,
  ): Promise<void> {
    await transaction.query(INSERT_AUDIT_SQL, [
      this.tenant_id,
      "appointment-agent",
      action,
      entity_type,
      entity_id,
      JSON.stringify(diff),
    ]);
  }

  private async record_rejection(
    error: Error,
    appointment_id: string,
    request_fingerprint: string,
  ): Promise<void> {
    try {
      await this.sql_client.query(INSERT_REJECTION_AUDIT_SQL, [
        this.tenant_id,
        rejection_action(error),
        appointment_id,
        JSON.stringify({ reason: error.name, request_fingerprint }),
      ]);
    } catch (audit_error) {
      throw new CalendarStoreError(
        "calendar-rejection-audit-failed",
        new AggregateError([error, audit_error], "calendar-rejection-audit-failed"),
      );
    }
  }

  private require_slot(slot_id: string): DurableSlot {
    const slot = this.slots.get(safe_calendar_text(slot_id, "slot_id"));
    if (slot === undefined) throw new SlotUnavailableError(slot_id);
    return slot;
  }
}

function translate_error(error: unknown, reason: string, fallback_id: string): Error {
  const domain_error = find_domain_error(error);
  if (domain_error !== null) return domain_error;
  const code = find_pg_code(error);
  if (code === "23P01" || code === "23505") return new SlotUnavailableError(fallback_id);
  if (error instanceof CalendarStoreError) return error;
  return new CalendarStoreError(reason, error);
}

function find_domain_error(error: unknown): Error | null {
  let current: unknown = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (is_domain_error(current)) return current;
    if (!current || typeof current !== "object" || !("cause" in current)) return null;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

function find_pg_code(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function is_domain_error(error: unknown): error is Error {
  return error instanceof SlotUnavailableError
    || error instanceof HoldExpiredError
    || error instanceof AppointmentNotFoundError
    || error instanceof AppointmentNotReschedulableError
    || error instanceof AppointmentVersionConflictError
    || error instanceof CalendarOperationConflictError;
}

function is_reschedule_rejection(error: Error): boolean {
  return error instanceof SlotUnavailableError
    || error instanceof HoldExpiredError
    || error instanceof AppointmentNotFoundError
    || error instanceof AppointmentNotReschedulableError
    || error instanceof AppointmentVersionConflictError
    || error instanceof CalendarOperationConflictError;
}

function rejection_action(error: Error): string {
  if (error instanceof HoldExpiredError) return "reschedule_hold_expired";
  if (error instanceof SlotUnavailableError) return "reschedule_conflicted";
  if (error instanceof AppointmentVersionConflictError) return "reschedule_version_conflicted";
  if (error instanceof AppointmentNotReschedulableError) return "reschedule_state_rejected";
  if (error instanceof AppointmentNotFoundError) return "reschedule_not_found";
  return "reschedule_operation_conflicted";
}
