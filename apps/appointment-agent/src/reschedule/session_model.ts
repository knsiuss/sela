/** Validated, PII-minimal state for one tenant conversation reschedule flow. */

import { z } from "zod";
import type { TimeSlot } from "../state.js";

/** Maximum PostgreSQL integer value used for generation and version fields. */
export const MAX_RESCHEDULE_SESSION_COUNTER = 2_147_483_647;

/** Maximum candidate slots retained from the existing graph result. */
export const MAX_RESCHEDULE_SESSION_SLOTS = 3;

const bounded_id_schema = z.string().trim().min(1).max(256);
const conversation_id_schema = z.string().trim().min(1).max(128);
const wamid_schema = z.string().trim().min(1).max(128);
const timestamp_schema = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => Number.isFinite(Date.parse(value)), "invalid timestamp");
const counter_schema = z.number().int().min(1).max(MAX_RESCHEDULE_SESSION_COUNTER);
const slot_schema = z.object({
  id: bounded_id_schema,
  start_iso: timestamp_schema,
  end_iso: timestamp_schema,
  staff: z.string().trim().min(1).max(128).optional(),
  resource: z.string().trim().min(1).max(128).optional(),
}).strict().refine((slot) => Date.parse(slot.end_iso) > Date.parse(slot.start_iso), {
  message: "slot end must follow start",
  path: ["end_iso"],
});

/** Legal persisted phases for the reschedule button flow. */
export const reschedule_session_phase_schema = z.enum([
  "offered",
  "awaiting_confirmation",
  "confirmed",
  "cancelled",
  "handoff",
]);

export type RescheduleSessionPhase = z.infer<typeof reschedule_session_phase_schema>;

const state_structure_schema = z.object({
  phase: reschedule_session_phase_schema,
  candidate_slots: z.array(slot_schema).max(MAX_RESCHEDULE_SESSION_SLOTS),
  chosen_slot_id: bounded_id_schema.nullable(),
  hold_id: bounded_id_schema.nullable(),
  hold_expires_at_iso: timestamp_schema.nullable(),
  offer_generation: counter_schema,
  last_wamid: wamid_schema.nullable(),
  expires_at_iso: timestamp_schema,
}).strict();

const session_structure_schema = state_structure_schema.extend({
  tenant_id: bounded_id_schema,
  conversation_id: conversation_id_schema,
  version: counter_schema,
  created_at_iso: timestamp_schema,
  updated_at_iso: timestamp_schema,
}).strict();

export type RescheduleSessionState = z.infer<typeof state_structure_schema>;
export type RescheduleSession = z.infer<typeof session_structure_schema>;

/** Safe validation failure that never includes the rejected state value. */
export class RescheduleSessionValidationError extends Error {
  /** Create a sanitized validation error. */
  constructor(reason = "reschedule-session-invalid") {
    super(reason);
    this.name = "RescheduleSessionValidationError";
  }
}

/**
 * Validate and copy mutable reschedule-session state.
 *
 * @param value - Candidate state assembled by a trusted processor.
 * @returns A normalized defensive value.
 * @throws RescheduleSessionValidationError when a bound or invariant fails.
 */
export function parse_reschedule_session_state(value: unknown): RescheduleSessionState {
  const parsed = state_structure_schema.safeParse(value);
  if (!parsed.success) throw new RescheduleSessionValidationError();
  assert_phase_invariants(parsed.data);
  return copy_slots(parsed.data);
}

/**
 * Validate and copy one complete persisted session.
 *
 * @param value - Candidate database or in-memory row.
 * @returns A normalized defensive value.
 * @throws RescheduleSessionValidationError when a bound or invariant fails.
 */
export function parse_reschedule_session(value: unknown): RescheduleSession {
  const parsed = session_structure_schema.safeParse(value);
  if (!parsed.success) throw new RescheduleSessionValidationError();
  assert_phase_invariants(parsed.data);
  return copy_slots(parsed.data);
}

function assert_phase_invariants(session: RescheduleSessionState): void {
  if (session.phase === "offered" && has_selection_or_hold(session)) {
    throw new RescheduleSessionValidationError();
  }
  if (session.phase === "awaiting_confirmation") {
    if (!has_complete_hold(session)) throw new RescheduleSessionValidationError();
    if (!session.candidate_slots.some((slot) => slot.id === session.chosen_slot_id)) {
      throw new RescheduleSessionValidationError();
    }
    return;
  }
  if (session.phase === "confirmed" && session.chosen_slot_id === null) {
    throw new RescheduleSessionValidationError();
  }
  if (session.phase === "handoff" && has_selection_or_hold(session)) {
    throw new RescheduleSessionValidationError();
  }
  if (session.hold_id !== null || session.hold_expires_at_iso !== null) {
    throw new RescheduleSessionValidationError();
  }
}

function has_complete_hold(session: RescheduleSessionState): boolean {
  return session.chosen_slot_id !== null
    && session.hold_id !== null
    && session.hold_expires_at_iso !== null;
}

function has_selection_or_hold(session: RescheduleSessionState): boolean {
  return session.chosen_slot_id !== null
    || session.hold_id !== null
    || session.hold_expires_at_iso !== null;
}

function copy_slots<T extends RescheduleSessionState>(session: T): T {
  return {
    ...session,
    candidate_slots: session.candidate_slots.map((slot): TimeSlot => ({ ...slot })),
  };
}
