/** Strict generation-bound action ids for deterministic reschedule buttons. */

import { MAX_RESCHEDULE_SESSION_COUNTER } from "./session_model.js";

/** Parsed deterministic action accepted by the default turn processor. */
export type RescheduleButtonAction =
  | { kind: "pick_slot"; option: number; generation: number }
  | { kind: "confirm_move"; generation: number }
  | { kind: "confirm_cancel"; generation: number }
  | { kind: "change_day"; generation: number };

const PICK_SLOT_PATTERN = /^pick_slot_([1-2])_g([1-9]\d{0,9})$/;
const ACTION_PATTERN = /^(confirm_move|confirm_cancel|change_day)_g([1-9]\d{0,9})$/;

/**
 * Parse one external button id without accepting prefixes or alternate syntax.
 *
 * @param button_id - Untrusted inbound quick-reply id.
 * @returns A typed action, or null when the exact bounded shape is invalid.
 */
export function parse_reschedule_button_action(button_id: string): RescheduleButtonAction | null {
  const pick_match = PICK_SLOT_PATTERN.exec(button_id);
  if (pick_match !== null) {
    return action_from_parts("pick_slot", Number(pick_match[2]), Number(pick_match[1]));
  }
  const action_match = ACTION_PATTERN.exec(button_id);
  if (action_match === null) return null;
  return action_from_parts(action_match[1] as "confirm_move" | "confirm_cancel" | "change_day", Number(action_match[2]));
}

function action_from_parts(
  kind: RescheduleButtonAction["kind"],
  generation: number,
  option?: number,
): RescheduleButtonAction | null {
  if (!Number.isSafeInteger(generation) || generation < 1 || generation > MAX_RESCHEDULE_SESSION_COUNTER) {
    return null;
  }
  if (kind === "pick_slot") {
    return option === 1 || option === 2 ? { kind, option, generation } : null;
  }
  return { kind, generation };
}

/**
 * Render a typed action as its canonical generation-bound id.
 *
 * @param action - Valid action assembled by the processor.
 * @returns The exact id persisted in the outbound button and inbound row.
 */
export function format_reschedule_button_action(action: RescheduleButtonAction): string {
  if (action.kind === "pick_slot") return `pick_slot_${action.option}_g${action.generation}`;
  return `${action.kind}_g${action.generation}`;
}
