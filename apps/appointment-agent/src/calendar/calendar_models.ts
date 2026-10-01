/** Validated values and fingerprints crossing the durable calendar boundary. */

import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { RescheduleAppointmentCommand, RescheduleAppointmentResult } from "../tools/calendar.js";
import type { TimeSlot } from "../state.js";

const MAX_VERSION = 2_147_483_647;
const id_schema = z.string().trim().min(1).max(256);
const uuid_schema = z.string().uuid();
const resource_id_schema = z.string().regex(/^[1-9]\d{0,18}$/);
const timestamp_schema = z.string().refine((value) => Number.isFinite(Date.parse(value)), "invalid timestamp");

/** Internal mutable catalog entry with a database resource binding. */
export interface DurableSlot extends TimeSlot {
  resource_id: string;
}

/** Strict availability-slot value accepted from runtime configuration. */
export const time_slot_schema = z.object({
  id: id_schema,
  start_iso: timestamp_schema,
  end_iso: timestamp_schema,
  staff: z.string().trim().min(1).max(128).optional(),
  resource: z.string().trim().min(1).max(128).optional(),
  resource_id: resource_id_schema.optional(),
}).strict().refine((value) => Date.parse(value.end_iso) > Date.parse(value.start_iso), {
  message: "slot end must follow start",
  path: ["end_iso"],
});

export const hold_operation_result_schema = z.object({
  operation_type: z.literal("hold"),
  hold_id: id_schema,
  held_appointment_id: uuid_schema,
  slot_id: id_schema,
  expires_at_iso: timestamp_schema,
}).strict();

export const confirm_operation_result_schema = z.object({
  operation_type: z.literal("confirm"),
  hold_id: id_schema,
  appointment_id: uuid_schema,
}).strict();

export const reschedule_operation_result_schema = z.object({
  operation_type: z.literal("reschedule"),
  appointment_id: uuid_schema,
  previous_version: z.number().int().min(1).max(MAX_VERSION),
  version: z.number().int().min(1).max(MAX_VERSION),
  hold_id: id_schema,
  target_slot_id: id_schema,
  status: z.literal("confirmed"),
}).strict();

export type HoldOperationResult = z.infer<typeof hold_operation_result_schema>;
export type ConfirmOperationResult = z.infer<typeof confirm_operation_result_schema>;
export type RescheduleOperationResult = z.infer<typeof reschedule_operation_result_schema>;
export type CalendarOperationResult =
  | HoldOperationResult
  | ConfirmOperationResult
  | RescheduleOperationResult;

/** Parse an operation-ledger result according to its committed operation type. */
export function parse_calendar_operation_result(
  operation_type: CalendarOperationResult["operation_type"],
  value: unknown,
): CalendarOperationResult {
  try {
    if (operation_type === "hold") return hold_operation_result_schema.parse(value);
    if (operation_type === "confirm") return confirm_operation_result_schema.parse(value);
    return reschedule_operation_result_schema.parse(value);
  } catch (error) {
    throw new Error("calendar-operation-result-invalid", { cause: error });
  }
}

export interface ValidatedRescheduleCommand extends RescheduleAppointmentCommand {
  fingerprint: string;
}

/** Validate a tenant-scoped source appointment id and optimistic version. */
export function validate_appointment_id(value: string): string {
  return uuid_schema.parse(value);
}

/** Validate a tenant database identifier used in SQL parameters. */
export function validate_tenant_id(value: string): string {
  return z.string().regex(/^[1-9]\d{0,18}$/).parse(value);
}

/** Validate a stable calendar operation key. */
export function validate_operation_key(value: string): string {
  return id_schema.parse(value);
}

/** Validate one request and bind a canonical request fingerprint. */
export function validate_reschedule_command(value: RescheduleAppointmentCommand): ValidatedRescheduleCommand {
  const parsed = z.object({
    tenant_id: z.string().regex(/^[1-9]\d{0,18}$/),
    appointment_id: uuid_schema,
    expected_version: z.number().int().min(1).max(MAX_VERSION),
    hold_id: id_schema,
    target_slot_id: id_schema,
    idempotency_key: id_schema,
  }).strict().parse(value);
  return {
    ...parsed,
    fingerprint: fingerprint([
      "reschedule-v1",
      parsed.tenant_id,
      parsed.appointment_id,
      String(parsed.expected_version),
      parsed.hold_id,
      parsed.target_slot_id,
    ]),
  };
}

/** Build the canonical fingerprint for a hold request. */
export function hold_fingerprint(input: {
  tenant_id: string;
  slot: DurableSlot;
  ttl_seconds: number;
  operation_key: string;
}): string {
  return fingerprint([
    "hold-v1",
    validate_tenant_id(input.tenant_id),
    input.slot.id,
    input.slot.resource_id,
    input.slot.start_iso,
    input.slot.end_iso,
    String(input.ttl_seconds),
    input.operation_key,
  ]);
}

/** Build the canonical fingerprint for a new-booking confirmation. */
export function confirm_fingerprint(input: {
  tenant_id: string;
  hold_id: string;
  operation_key: string;
}): string {
  return fingerprint([
    "confirm-v1",
    validate_tenant_id(input.tenant_id),
    id_schema.parse(input.hold_id),
    validate_operation_key(input.operation_key),
  ]);
}

/** Build a PII-free opaque customer reference for a temporary held row. */
export function hold_customer_reference(tenant_id: string, operation_key: string): string {
  return `hold:${fingerprint(["customer-ref-v1", tenant_id, operation_key]).slice(0, 32)}`;
}

/** Create a stable request fingerprint that excludes message and recipient data. */
export function fingerprint(parts: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** Generate an opaque appointment row identifier. */
export function new_appointment_id(): string {
  return randomUUID();
}

/** Convert a committed database result to the public reschedule contract. */
export function public_reschedule_result(result: RescheduleOperationResult): RescheduleAppointmentResult {
  return {
    appointment_id: result.appointment_id,
    previous_version: result.previous_version,
    version: result.version,
    hold_id: result.hold_id,
    target_slot_id: result.target_slot_id,
    status: result.status,
  };
}

/** Parse a JSON value returned by pg without trusting its shape. */
export function parse_json(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return JSON.parse(value) as unknown;
}

/** Validate a stable resource id supplied by the availability source. */
export function validate_resource_id(value: string): string {
  return resource_id_schema.parse(value);
}
