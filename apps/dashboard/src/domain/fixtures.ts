/**
 * Deterministic synthetic data for the unauthenticated local dashboard.
 *
 * Every conflict and queue row is produced by the real domain constructors
 * with an injected clock, so a fixture can never drift away from the validators
 * the backend enforces. Nothing here resembles real PII: identifiers are
 * obviously fake and no customer content exists in this file.
 */

import type { CalendarAppointment, CalendarAppointmentStatus } from "appointment-agent/dist/src/tools/calendar.js";
import {
  open_conflict,
  type ConflictRecord,
  type ConflictStatus,
} from "appointment-agent/dist/src/enterprise/conflict_resolution.js";
import { enqueue_item, type QueueItem } from "appointment-agent/dist/src/enterprise/operator_queue.js";

/** Tenant the local fixtures belong to. */
export const FIXTURE_TENANT_ID = "1001";

/** Second tenant used only to prove tenant scoping hides foreign rows. */
export const FOREIGN_FIXTURE_TENANT_ID = "2002";

/** Minute window used for every synthetic SLA and conflict deadline. */
const SHORT_WINDOW_MINUTES = 30;

const MINUTE_MS = 60_000;

/** The synthetic dataset the local workspace starts from. */
export interface WorkspaceFixture {
  /** Appointments belonging to the local tenant. */
  appointments: readonly CalendarAppointment[];
  /** Appointment rows belonging to another tenant, which must never render. */
  foreign_appointments: readonly CalendarAppointment[];
  /** Conflicts covering every lifecycle status. */
  conflicts: readonly ConflictRecord[];
  /** Queue items covering every status, including the escalation cap. */
  queue_items: readonly QueueItem[];
}

interface ConflictSeed {
  conflict_id: string;
  appointment_id: string;
  status: ConflictStatus;
  generation: number;
  ttl_minutes: number;
  proposed_offset_minutes: number | null;
}

interface QueueSeed {
  item_id: string;
  sla_minutes: number;
  status: "unassigned" | "assigned" | "escalated" | "resolved";
  assignee_subject: string | null;
  escalation_level: number;
}

const APPOINTMENT_SEEDS: ReadonlyArray<{
  appointment_id: string;
  tenant_id: string;
  status: CalendarAppointmentStatus;
  resource_id: string;
  starts_offset_hours: number;
  duration_minutes: number;
}> = [
  { appointment_id: "appt-fixture-a1", tenant_id: FIXTURE_TENANT_ID, status: "confirmed", resource_id: "701", starts_offset_hours: 2, duration_minutes: 45 },
  { appointment_id: "appt-fixture-a2", tenant_id: FIXTURE_TENANT_ID, status: "held", resource_id: "701", starts_offset_hours: 5, duration_minutes: 30 },
  { appointment_id: "appt-fixture-a3", tenant_id: FIXTURE_TENANT_ID, status: "confirmed", resource_id: "702", starts_offset_hours: 26, duration_minutes: 60 },
  { appointment_id: "appt-fixture-a4", tenant_id: FIXTURE_TENANT_ID, status: "no_show", resource_id: "702", starts_offset_hours: 50, duration_minutes: 30 },
  { appointment_id: "appt-fixture-a5", tenant_id: FIXTURE_TENANT_ID, status: "cancelled", resource_id: "703", starts_offset_hours: 74, duration_minutes: 45 },
  { appointment_id: "appt-fixture-b1", tenant_id: FOREIGN_FIXTURE_TENANT_ID, status: "confirmed", resource_id: "901", starts_offset_hours: 3, duration_minutes: 45 },
  { appointment_id: "appt-fixture-b2", tenant_id: FOREIGN_FIXTURE_TENANT_ID, status: "confirmed", resource_id: "902", starts_offset_hours: 8, duration_minutes: 30 },
];

const CONFLICT_SEEDS: readonly ConflictSeed[] = [
  { conflict_id: "conflict-fixture-pending", appointment_id: "appt-fixture-a2", status: "pending", generation: 3, ttl_minutes: SHORT_WINDOW_MINUTES, proposed_offset_minutes: null },
  { conflict_id: "conflict-fixture-proposed", appointment_id: "appt-fixture-a3", status: "proposed", generation: 1, ttl_minutes: SHORT_WINDOW_MINUTES, proposed_offset_minutes: 30 },
  { conflict_id: "conflict-fixture-accepted", appointment_id: "appt-fixture-a1", status: "accepted", generation: 2, ttl_minutes: SHORT_WINDOW_MINUTES, proposed_offset_minutes: 20 },
  { conflict_id: "conflict-fixture-rejected", appointment_id: "appt-fixture-a5", status: "rejected", generation: 1, ttl_minutes: SHORT_WINDOW_MINUTES, proposed_offset_minutes: 40 },
  { conflict_id: "conflict-fixture-expired", appointment_id: "appt-fixture-a4", status: "expired", generation: 4, ttl_minutes: SHORT_WINDOW_MINUTES, proposed_offset_minutes: 60 },
];

const QUEUE_SEEDS: readonly QueueSeed[] = [
  { item_id: "queue-fixture-unassigned", sla_minutes: SHORT_WINDOW_MINUTES, status: "unassigned", assignee_subject: null, escalation_level: 0 },
  { item_id: "queue-fixture-assigned", sla_minutes: 45, status: "assigned", assignee_subject: "local-operator", escalation_level: 0 },
  { item_id: "queue-fixture-escalated", sla_minutes: 10, status: "escalated", assignee_subject: "local-operator", escalation_level: 2 },
  { item_id: "queue-fixture-breached", sla_minutes: -30, status: "assigned", assignee_subject: "local-operator", escalation_level: 1 },
  { item_id: "queue-fixture-capped", sla_minutes: 90, status: "escalated", assignee_subject: "local-operator", escalation_level: 3 },
  { item_id: "queue-fixture-resolved", sla_minutes: -60, status: "resolved", assignee_subject: "local-operator", escalation_level: 0 },
];

const TERMINAL_STATUSES: readonly ConflictStatus[] = ["accepted", "rejected", "expired"];

/**
 * Build the synthetic dataset relative to a reference time.
 *
 * @param now_ms - Reference epoch milliseconds; tests pass a fixed value.
 * @returns Appointments, conflicts, and queue items for the local tenant.
 */
export function create_workspace_fixture(now_ms: number): WorkspaceFixture {
  const clock = (): Date => new Date(now_ms);
  return {
    appointments: APPOINTMENT_SEEDS.filter((seed) => seed.tenant_id === FIXTURE_TENANT_ID).map((seed) => appointment(seed, now_ms)),
    foreign_appointments: APPOINTMENT_SEEDS.filter((seed) => seed.tenant_id === FOREIGN_FIXTURE_TENANT_ID).map((seed) => appointment(seed, now_ms)),
    conflicts: CONFLICT_SEEDS.map((seed) => conflict(seed, now_ms, clock)),
    queue_items: QUEUE_SEEDS.map((seed) => queue_item(seed, now_ms, clock)),
  };
}

function appointment(seed: (typeof APPOINTMENT_SEEDS)[number], now_ms: number): CalendarAppointment {
  const starts_ms = now_ms + seed.starts_offset_hours * 60 * MINUTE_MS;
  return {
    appointment_id: seed.appointment_id,
    tenant_id: seed.tenant_id,
    version: 1,
    status: seed.status,
    resource_id: seed.resource_id,
    starts_at_iso: new Date(starts_ms).toISOString(),
    ends_at_iso: new Date(starts_ms + seed.duration_minutes * MINUTE_MS).toISOString(),
  };
}

function conflict(seed: ConflictSeed, now_ms: number, clock: () => Date): ConflictRecord {
  const opened = open_conflict({
    conflict_id: seed.conflict_id,
    tenant_id: FIXTURE_TENANT_ID,
    appointment_id: seed.appointment_id,
    generation: seed.generation,
    ttl_minutes: seed.ttl_minutes,
    clock,
  });
  const decided_at_iso = TERMINAL_STATUSES.includes(seed.status) ? new Date(now_ms - 5 * MINUTE_MS).toISOString() : null;
  return {
    ...opened,
    status: seed.status,
    proposed_slot_iso: seed.proposed_offset_minutes === null
      ? null
      : new Date(now_ms + seed.proposed_offset_minutes * MINUTE_MS).toISOString(),
    decided_at_iso,
  };
}

function queue_item(seed: QueueSeed, now_ms: number, clock: () => Date): QueueItem {
  const enqueued = enqueue_item({
    item_id: seed.item_id,
    tenant_id: FIXTURE_TENANT_ID,
    sla_minutes: Math.abs(seed.sla_minutes),
    clock,
  });
  const due_offset_ms = seed.sla_minutes * MINUTE_MS;
  return {
    ...enqueued,
    status: seed.status,
    assignee_subject: seed.assignee_subject,
    escalation_level: seed.escalation_level,
    sla_due_at_iso: new Date(now_ms + due_offset_ms).toISOString(),
  };
}