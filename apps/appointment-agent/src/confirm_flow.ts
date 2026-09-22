import { HoldExpiredError, type CalendarPort } from "./tools/calendar.js";
import {
  button_set_schema,
  MAX_BUTTONS_PER_MESSAGE,
  type ConfirmState,
  type QuickReplyButton,
} from "./agent_types.js";

export class InvalidConfirmTransitionError extends Error {
  constructor(reason: string) {
    super(`invalid-confirm-transition: ${reason}`);
    this.name = "InvalidConfirmTransitionError";
  }
}

export class ConfirmHoldExpiredError extends Error {
  constructor(readonly hold_id: string) {
    super(`confirm-hold-expired: ${hold_id}`);
    this.name = "ConfirmHoldExpiredError";
  }
}

/** Default hold lifetime; the lower bound of the 5-10 minute booking pipeline window. */
export const DEFAULT_HOLD_TTL_SECONDS = 300;

/** Booking confirmation context carried across turns so users never repeat input. */
export interface ConfirmContext {
  state: ConfirmState;
  conversation_id: string;
  request_id: string;
  slot_id?: string;
  hold_id?: string;
  expires_at_iso?: string;
}

/**
 * Create a fresh confirmation context in the free state.
 *
 * Args:
 *   conversation_id: Hashed conversation key, never a raw phone number.
 *   request_id: Request id tying this turn to the audit log.
 *
 * Returns:
 *   A context with no slot selected.
 *
 * Raises:
 *   InvalidConfirmTransitionError: If either id is empty.
 */
export function create_confirm_context(conversation_id: string, request_id: string): ConfirmContext {
  if (conversation_id === "" || request_id === "") {
    throw new InvalidConfirmTransitionError("empty-ids");
  }
  return { state: "free", conversation_id, request_id };
}

/**
 * Check whether a held slot has passed its server-enforced expiry.
 *
 * Unparseable expiries count as expired so the flow fails closed toward
 * re-offering instead of confirming a stale hold.
 *
 * Args:
 *   context: Current confirmation context.
 *   now_ms: Epoch millis to compare against; defaults to the current time.
 *
 * Returns:
 *   True only when the context is held and its expiry has passed.
 */
export function is_confirm_hold_expired(context: ConfirmContext, now_ms: number = Date.now()): boolean {
  if (context.state !== "held" || context.expires_at_iso === undefined) return false;
  const expires_ms = Date.parse(context.expires_at_iso);
  if (Number.isNaN(expires_ms)) return true;
  return expires_ms <= now_ms;
}

/**
 * Claim a slot into the held state for later confirmation.
 *
 * Only a free context can take a hold; the single-writer calendar rejects
 * double claims and the hold carries a server-enforced TTL.
 *
 * Args:
 *   context: Current confirmation context, must be free.
 *   slot_id: Slot to hold.
 *   calendar: Single writer owning all slot mutations.
 *   ttl_seconds: Hold lifetime; defaults to the pipeline lower bound.
 *
 * Returns:
 *   The context moved to held with hold id and expiry filled.
 *
 * Raises:
 *   InvalidConfirmTransitionError: If the context is not free or the slot id is empty.
 */
export async function hold_slot_for_confirm(
  context: ConfirmContext,
  slot_id: string,
  calendar: CalendarPort,
  ttl_seconds: number = DEFAULT_HOLD_TTL_SECONDS,
): Promise<ConfirmContext> {
  if (context.state !== "free") throw new InvalidConfirmTransitionError(`hold-from-${context.state}`);
  if (slot_id === "") throw new InvalidConfirmTransitionError("empty-slot-id");
  const hold = await calendar.hold_slot(slot_id, ttl_seconds);
  return { ...context, state: "held", slot_id, hold_id: hold.hold_id, expires_at_iso: hold.expires_at_iso };
}

/**
 * Confirm a held slot after re-checking that the hold is still live.
 *
 * The expiry re-check inside the write path is the anti-double-book
 * invariant: a confirm never trusts a stale read of availability.
 *
 * Args:
 *   context: Current confirmation context, must be held and unexpired.
 *   calendar: Single writer owning all slot mutations.
 *   idempotency_key: Stable key making retries write exactly once.
 *
 * Returns:
 *   The context moved to confirmed.
 *
 * Raises:
 *   InvalidConfirmTransitionError: If the context is not held.
 *   ConfirmHoldExpiredError: If the hold lapsed before the write.
 */
export async function confirm_held_slot(
  context: ConfirmContext,
  calendar: CalendarPort,
  idempotency_key: string,
): Promise<ConfirmContext> {
  if (context.state !== "held") throw new InvalidConfirmTransitionError(`confirm-from-${context.state}`);
  if (context.hold_id === undefined) throw new InvalidConfirmTransitionError("hold-without-id");
  if (is_confirm_hold_expired(context)) {
    throw new ConfirmHoldExpiredError(context.hold_id);
  }
  try {
    await calendar.confirm_hold(context.hold_id, idempotency_key);
  } catch (error) {
    if (error instanceof HoldExpiredError) throw new ConfirmHoldExpiredError(context.hold_id);
    throw error;
  }
  return { ...context, state: "confirmed", hold_id: undefined, expires_at_iso: undefined };
}

/**
 * Move a lapsed held context to expired without touching the calendar.
 *
 * The calendar row still expires server-side on its own TTL; this only
 * updates the conversation view so the agent re-offers instead of confirming.
 *
 * Args:
 *   context: Current confirmation context.
 *   now_ms: Epoch millis to compare against; defaults to the current time.
 *
 * Returns:
 *   The context moved to expired when lapsed, otherwise unchanged.
 */
export function expire_confirm_if_needed(context: ConfirmContext, now_ms: number = Date.now()): ConfirmContext {
  if (!is_confirm_hold_expired(context, now_ms)) return context;
  return { ...context, state: "expired", hold_id: undefined, expires_at_iso: undefined };
}

/**
 * Release a held slot back to free without confirming.
 *
 * Only a held context can be released; confirmed bookings need the cancel
 * path instead, so this fails loud rather than silently freeing them.
 *
 * Args:
 *   context: Current confirmation context, must be held.
 *   calendar: Single writer owning all slot mutations.
 *
 * Returns:
 *   The context moved back to free with slot references cleared.
 *
 * Raises:
 *   InvalidConfirmTransitionError: If the context is not held.
 */
export async function release_confirm(context: ConfirmContext, calendar: CalendarPort): Promise<ConfirmContext> {
  if (context.state !== "held") throw new InvalidConfirmTransitionError(`release-from-${context.state}`);
  if (context.hold_id !== undefined) await calendar.release_hold(context.hold_id);
  return { ...context, state: "free", slot_id: undefined, hold_id: undefined, expires_at_iso: undefined };
}

/**
 * Build the canonical reconfirm button pair for a held slot.
 *
 * Free text is only accepted for date, time, and reason; the final decision
 * always goes through these buttons so the write intent is unambiguous.
 *
 * Returns:
 *   Two validated quick-reply buttons: confirm the move, or cancel.
 */
export function build_reconfirm_buttons(): QuickReplyButton[] {
  return button_set_schema.parse([
    { button_id: "confirm_move", label: "Confirm move" },
    { button_id: "confirm_cancel", label: "Cancel" },
  ]);
}

/**
 * Build deterministic slot-offer buttons for up to three options.
 *
 * Labels are positional ("Pick slot 1") and the caller keeps the
 * button-to-slot mapping in the conversation context, so no NLU is needed
 * to resolve the tap. A trailing "Change day" button covers overflow.
 *
 * Args:
 *   slot_count: Number of available options the caller will map by position.
 *
 * Returns:
 *   One to three validated quick-reply buttons.
 *
 * Raises:
 *   InvalidConfirmTransitionError: If there is nothing to offer.
 */
export function build_slot_option_buttons(slot_count: number): QuickReplyButton[] {
  if (!Number.isInteger(slot_count) || slot_count <= 0) {
    throw new InvalidConfirmTransitionError("no-slots-to-offer");
  }
  const options = Math.min(slot_count, MAX_BUTTONS_PER_MESSAGE - 1);
  const buttons: QuickReplyButton[] = [];
  for (let index = 1; index <= options; index += 1) {
    buttons.push({ button_id: `pick_slot_${index}`, label: `Pick slot ${index}` });
  }
  buttons.push({ button_id: "change_day", label: "Change day" });
  return button_set_schema.parse(buttons);
}
