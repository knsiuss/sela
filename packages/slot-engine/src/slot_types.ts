/** Slot-engine shared types and validation schemas.
 *
 * Single source of truth for every value that crosses the slot-engine
 * boundary. All service methods parse their param objects with these
 * schemas first, so invalid input fails fast at the edge.
 */

import { z } from "zod";

/** Default hold lifetime: ~10 minutes per UCP #317 server TTL. */
export const DEFAULT_HOLD_TTL_SECONDS = 600;

/**
 * Maximum hold lifetime. Clients cannot extend a lease past this;
 * the server clamps any requested TTL down to this value.
 */
export const MAX_HOLD_TTL_SECONDS = 600;

/** Appointment lifecycle states, mirroring the Postgres appointments table. */
export const appointment_status_schema = z.enum(["held", "confirmed", "cancelled"]);

export const hold_request_schema = z.object({
  tenant_id: z.string().min(1),
  provider_id: z.string().min(1),
  start_time: z.iso.datetime(),
  end_time: z.iso.datetime(),
  ttl_seconds: z.number().int().positive().default(DEFAULT_HOLD_TTL_SECONDS),
});

export const availability_query_schema = z.object({
  tenant_id: z.string().min(1),
  provider_id: z.string().min(1),
  start_time: z.iso.datetime(),
  end_time: z.iso.datetime(),
});

export const confirm_request_schema = z.object({
  hold_id: z.string().min(1),
  tenant_id: z.string().min(1),
  idempotency_key: z.string().min(1),
});

export const reschedule_request_schema = z
  .object({
    appointment_id: z.string().min(1),
    tenant_id: z.string().min(1),
    new_start_time: z.iso.datetime(),
    new_end_time: z.iso.datetime(),
  })
  .refine((value) => Date.parse(value.new_end_time) > Date.parse(value.new_start_time), {
    message: "new_end_time must be after new_start_time",
  });

export const hold_schema = z.object({
  hold_id: z.string().min(1),
  slot_key: z.string().min(1),
  tenant_id: z.string().min(1),
  provider_id: z.string().min(1),
  start_time: z.iso.datetime(),
  end_time: z.iso.datetime(),
  expires_at: z.iso.datetime(),
  created_at: z.iso.datetime(),
});

export const appointment_schema = z.object({
  id: z.string().min(1),
  tenant_id: z.string().min(1),
  provider_id: z.string().min(1),
  start_time: z.iso.datetime(),
  end_time: z.iso.datetime(),
  status: appointment_status_schema,
  idempotency_key: z.string().min(1),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});

export type HoldRequest = z.input<typeof hold_request_schema>;
export type AvailabilityQuery = z.input<typeof availability_query_schema>;
export type ConfirmRequest = z.input<typeof confirm_request_schema>;
export type RescheduleRequest = z.input<typeof reschedule_request_schema>;
export type Hold = z.infer<typeof hold_schema>;
export type Appointment = z.infer<typeof appointment_schema>;
export type AppointmentStatus = z.infer<typeof appointment_status_schema>;

export interface SlotKeyParts {
  tenant_id: string;
  provider_id: string;
  start_time: string;
}

/**
 * Build the tenant-scoped slot key.
 *
 * Scoping by tenant first keeps one tenant's lease from ever colliding
 * with another's, even when provider ids or start times coincide.
 *
 * Args:
 *   parts: Tenant id, provider id, and slot start time (ISO string).
 *
 * Returns:
 *   Canonical key in the form "tenant_id:provider_id:start_time".
 */
export function build_slot_key(parts: SlotKeyParts): string {
  return `${parts.tenant_id}:${parts.provider_id}:${parts.start_time}`;
}
