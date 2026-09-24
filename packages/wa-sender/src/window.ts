/** Pure and stateful helpers for WhatsApp's 24-hour service window. */

import type { TimestampInput } from "./types.js";

/** Meta customer service window duration. */
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Injectable millisecond clock used by the tracker. */
export type Clock = () => number;

/** Error raised when an injected clock produces an invalid timestamp. */
export class ServiceWindowError extends Error {
  /** Create a safe service-window error. */
  constructor() {
    super("service-window-clock-invalid");
    this.name = "ServiceWindowError";
  }
}

/**
 * Check whether a free-form message is allowed at the supplied time.
 *
 * Invalid timestamps fail closed. A timestamp before the last inbound message
 * also fails closed because a future-dated event cannot prove an open window.
 *
 * @param now - Current instant supplied by the caller.
 * @param last_inbound - Most recent user-message instant, if one exists.
 * @returns True only inside the 24-hour window.
 */
export function can_send_free_form(
  now: TimestampInput,
  last_inbound: TimestampInput | null | undefined,
): boolean {
  const now_ms = to_epoch_ms(now);
  const inbound_ms = to_epoch_ms(last_inbound);
  if (now_ms === undefined || inbound_ms === undefined || now_ms < inbound_ms) return false;
  return now_ms - inbound_ms <= SERVICE_WINDOW_MS;
}

/**
 * Determine whether a message must use an approved template.
 *
 * @param now - Current instant supplied by the caller.
 * @param last_inbound - Most recent user-message instant, if one exists.
 * @returns True when free-form delivery is not permitted.
 */
export function requires_template(
  now: TimestampInput,
  last_inbound: TimestampInput | null | undefined,
): boolean {
  return !can_send_free_form(now, last_inbound);
}

/**
 * Track the last inbound user message for one conversation.
 *
 * The clock is injected so production code and tests use the same deterministic
 * state transition without reading a global clock inside the policy functions.
 */
export class ServiceWindowTracker {
  private readonly clock: Clock;
  private last_inbound_ms: number | undefined;

  /**
   * Create a tracker.
   *
   * @param clock - Millisecond clock; defaults to Date.now.
   * @param initial_last_inbound - Optional persisted inbound timestamp.
   * @throws ServiceWindowError when the clock is not callable or returns an invalid value.
   */
  constructor(clock: Clock = Date.now, initial_last_inbound?: TimestampInput) {
    if (typeof clock !== "function") throw new ServiceWindowError();
    this.clock = clock;
    if (initial_last_inbound !== undefined) this.last_inbound_ms = require_epoch_ms(initial_last_inbound);
  }

  /**
   * Record an inbound user message, starting or resetting the window.
   *
   * @param at_ms - Optional event timestamp; defaults to the injected clock.
   * @returns The recorded epoch-millisecond timestamp.
   * @throws ServiceWindowError when the supplied timestamp is invalid.
   */
  record_inbound(at_ms?: TimestampInput): number {
    const recorded_ms = at_ms === undefined ? this.read_clock() : require_epoch_ms(at_ms);
    this.last_inbound_ms = recorded_ms;
    return recorded_ms;
  }

  /**
   * Get the currently tracked inbound timestamp.
   *
   * @returns The last inbound epoch milliseconds, or undefined.
   */
  get last_inbound_at_ms(): number | undefined {
    return this.last_inbound_ms;
  }

  /**
   * Check free-form eligibility at the current injected time.
   *
   * @param now_ms - Optional override for deterministic callers.
   * @returns True when the 24-hour window is open.
   */
  is_open(now_ms: number = this.read_clock()): boolean {
    return can_send_free_form(now_ms, this.last_inbound_ms);
  }

  /**
   * Check whether a template is required at the current injected time.
   *
   * @param now_ms - Optional override for deterministic callers.
   * @returns True when free-form delivery is not permitted.
   */
  template_required(now_ms: number = this.read_clock()): boolean {
    return requires_template(now_ms, this.last_inbound_ms);
  }

  private read_clock(): number {
    return require_epoch_ms(this.clock());
  }
}

function to_epoch_ms(value: TimestampInput | null | undefined): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.getTime() : undefined;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const parsed_ms = Date.parse(value);
    return Number.isFinite(parsed_ms) ? parsed_ms : undefined;
  }
  return undefined;
}

function require_epoch_ms(value: TimestampInput): number {
  const epoch_ms = to_epoch_ms(value);
  if (epoch_ms === undefined) throw new ServiceWindowError();
  return epoch_ms;
}
