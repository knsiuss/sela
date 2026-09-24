/** Canonical consent-card construction for resolved voice-note proposals. */

import { get_local_datetime_parts, is_valid_timezone } from "./datetime.js";
import type { ConsentCard, ConsentCardButton, ProposedSlot } from "./types.js";

/** WhatsApp-safe upper bound for every consent action label. */
export const MAX_CONSENT_BUTTON_LABEL_CHARS = 20;

/** Domain error for a proposal that cannot be represented canonically. */
export class InvalidConsentCardInputError extends Error {
  constructor(reason: string) {
    super(`invalid-consent-card-input: ${reason}`);
    this.name = "InvalidConsentCardInputError";
  }
}

const CONSENT_BUTTONS: ConsentCardButton[] = [
  { button_id: "confirm", label: "Confirm" },
  { button_id: "other_day", label: "Other day" },
  { button_id: "cancel", label: "Cancel" },
];

/**
 * Build the mandatory confirmation card for one complete proposed slot.
 *
 * The card is derived from the absolute instant and timezone, then checked
 * against the canonical fields. The confirmation flag is intentionally not
 * configurable: no caller may turn a voice-note proposal into an auto-write.
 *
 * Args:
 *   proposed_slot: Complete local proposal with an absolute start instant.
 *
 * Returns:
 *   A canonical card containing day, date, time, timezone, and three actions.
 *
 * Raises:
 *   InvalidConsentCardInputError: If the proposal is incomplete, malformed,
 *     or inconsistent with its timezone representation.
 */
export function build_consent_card(proposed_slot: ProposedSlot): ConsentCard {
  validate_proposed_slot(proposed_slot);
  return {
    type: "consent_card",
    day: proposed_slot.day,
    date: proposed_slot.date,
    time: proposed_slot.time,
    timezone: proposed_slot.timezone,
    requires_confirmation: true,
    buttons: CONSENT_BUTTONS.map((button) => ({ ...button })),
  };
}

function validate_proposed_slot(proposed_slot: ProposedSlot): void {
  if (proposed_slot === undefined || proposed_slot === null) {
    throw new InvalidConsentCardInputError("missing-slot");
  }
  if (!is_valid_timezone(proposed_slot.timezone)) {
    throw new InvalidConsentCardInputError("invalid-timezone");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(proposed_slot.date)) {
    throw new InvalidConsentCardInputError("invalid-date");
  }
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(proposed_slot.time)) {
    throw new InvalidConsentCardInputError("invalid-time");
  }
  const start_ms = Date.parse(proposed_slot.start_iso);
  if (!Number.isFinite(start_ms)) {
    throw new InvalidConsentCardInputError("invalid-start-instant");
  }
  const local_parts = get_local_datetime_parts(new Date(start_ms), proposed_slot.timezone);
  const expected_date = `${String(local_parts.year).padStart(4, "0")}-${String(local_parts.month).padStart(2, "0")}-${String(local_parts.day).padStart(2, "0")}`;
  const expected_time = `${String(local_parts.hour).padStart(2, "0")}:${String(local_parts.minute).padStart(2, "0")}`;
  if (proposed_slot.date !== expected_date || proposed_slot.time !== expected_time) {
    throw new InvalidConsentCardInputError("inconsistent-canonical-fields");
  }
  const expected_day = new Intl.DateTimeFormat("en-US", {
    timeZone: proposed_slot.timezone,
    weekday: "long",
  }).format(new Date(start_ms));
  if (proposed_slot.day !== expected_day) {
    throw new InvalidConsentCardInputError("inconsistent-weekday");
  }
}
