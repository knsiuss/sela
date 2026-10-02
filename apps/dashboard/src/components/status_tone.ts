/**
 * Semantic state -> visual tone, for every state the workspace renders.
 *
 * Tone is a colour decision only. Meaning is always carried by the visible text
 * label that the domain modules own (`conflict_status_label`,
 * `queue_status_label`, `sla_state_label`, `audit_outcome_label`) plus the
 * shape marker `StatusBadge` draws, so no state is ever signalled by hue alone.
 *
 * This is the single home of the mapping. The components used to carry four
 * separate `STATUS_TONES` records, which meant a new domain state could be
 * added to one board and silently fall back to grey on the others.
 */

/** Visual tone of a badge; orthogonal to the meaning it carries. */
export type BadgeTone = "neutral" | "positive" | "warning" | "critical";

/** Tone for a state with no explicit mapping. Never throws on unknown input. */
export const DEFAULT_TONE: BadgeTone = "neutral";

/**
 * Every domain state this workspace can render.
 *
 * Listed explicitly rather than derived from the map so a test can assert the
 * two agree, and so a domain state added later fails that assertion instead of
 * quietly rendering grey.
 */
export const KNOWN_STATUSES: readonly string[] = [
  // Appointment lifecycle.
  "confirmed", "held", "cancelled", "completed", "no_show",
  // Conflict lifecycle.
  "pending", "proposed", "accepted", "rejected", "expired",
  // Operator queue lifecycle.
  "unassigned", "assigned", "escalated", "resolved",
  // SLA urgency, derived by the queue domain from the deadline.
  "on_track", "due_soon", "breached", "met",
  // Audited action outcomes.
  "succeeded", "denied", "failed",
];

const STATUS_TONES: Readonly<Record<string, BadgeTone>> = {
  confirmed: "positive",
  held: "warning",
  cancelled: "neutral",
  completed: "neutral",
  no_show: "critical",

  pending: "warning",
  proposed: "warning",
  accepted: "positive",
  rejected: "critical",
  expired: "neutral",

  unassigned: "warning",
  assigned: "neutral",
  escalated: "critical",
  resolved: "positive",

  on_track: "positive",
  due_soon: "warning",
  breached: "critical",
  met: "neutral",

  succeeded: "positive",
  denied: "critical",
  failed: "warning",
};

/**
 * Resolve the tone for one domain state.
 *
 * @param status - Raw domain state, for example `breached` or `no_show`.
 * @returns The mapped tone, or {@link DEFAULT_TONE} for an unmapped state.
 */
export function status_tone(status: string): BadgeTone {
  return STATUS_TONES[status] ?? DEFAULT_TONE;
}

/**
 * Whether a state has an explicit tone.
 *
 * @param status - Raw domain state.
 * @returns True when the state appears in the mapping.
 */
export function is_known_status(status: string): boolean {
  return Object.hasOwn(STATUS_TONES, status);
}