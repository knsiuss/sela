/**
 * Operator-facing timestamp rendering.
 *
 * Two deliberate constraints:
 *
 * 1. Locale and time zone are pinned to `en-GB` / `UTC`. These strings are
 *    produced on the server for the initial render and again on the client
 *    during hydration; anything that varies by environment (default locale,
 *    machine time zone) would produce a mismatch.
 * 2. The year is never rendered. P2.2 treats any run of four or more digits in
 *    rendered text as a potential phone number or confirmation code, and
 *    `test/redaction.test.tsx` enforces that. The machine-readable instant
 *    stays in the `dateTime` attribute of `<time>`.
 */

/** Shown instead of a timestamp that cannot be parsed. */
export const UNKNOWN_TIME = "—";

const DATE_TIME = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});

const DAY = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "2-digit",
  month: "short",
  timeZone: "UTC",
});

const CLOCK = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});

/**
 * Format an instant for display, or the placeholder when it is unparseable.
 *
 * @param iso - Instant as an ISO 8601 string.
 * @param formatter - Formatter to apply once the instant is known valid.
 * @returns Formatted UTC text, or {@link UNKNOWN_TIME}.
 */
function format_or_unknown(iso: string, formatter: Intl.DateTimeFormat): string {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return UNKNOWN_TIME;
  return formatter.format(instant);
}

/**
 * Format a full stamp such as `Mon 02 Mar, 09:00`.
 *
 * @param iso - Instant as an ISO 8601 string.
 * @returns Formatted UTC text, or {@link UNKNOWN_TIME}.
 */
export function format_datetime(iso: string): string {
  return format_or_unknown(iso, DATE_TIME);
}

/**
 * Format a date without the clock, such as `Mon 02 Mar`.
 *
 * @param iso - Instant as an ISO 8601 string.
 * @returns Formatted UTC text, or {@link UNKNOWN_TIME}.
 */
export function format_day(iso: string): string {
  return format_or_unknown(iso, DAY);
}

/**
 * Format only the clock, such as `09:00`.
 *
 * @param iso - Instant as an ISO 8601 string.
 * @returns Formatted UTC text, or {@link UNKNOWN_TIME}.
 */
export function format_time(iso: string): string {
  return format_or_unknown(iso, CLOCK);
}