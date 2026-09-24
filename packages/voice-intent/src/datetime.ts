/** Timezone-safe conversion helpers used by parsing and card rendering. */

/** Calendar fields without an offset. */
export interface LocalDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/**
 * Check whether a timezone is understood by the runtime.
 *
 * Args:
 *   timezone: IANA timezone identifier supplied by the application.
 *
 * Returns:
 *   True when Intl can construct a formatter for the identifier.
 */
export function is_valid_timezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

/**
 * Read local calendar fields for an instant in a named timezone.
 *
 * Args:
 *   instant: Absolute instant to render.
 *   timezone: Valid IANA timezone identifier.
 *
 * Returns:
 *   Local year, month, day, hour, and minute.
 *
 * Raises:
 *   RangeError: If the instant or timezone is invalid.
 */
export function get_local_datetime_parts(
  instant: Date,
  timezone: string,
): LocalDateTimeParts {
  if (Number.isNaN(instant.getTime())) throw new RangeError("instant must be a valid date");
  if (!is_valid_timezone(timezone)) throw new RangeError("timezone must be a valid IANA name");

  const values: Record<string, string> = {};
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  for (const part of formatter.formatToParts(instant)) values[part.type] = part.value;
  return {
    year: to_integer(values.year, "year"),
    month: to_integer(values.month, "month"),
    day: to_integer(values.day, "day"),
    hour: normalize_hour(to_integer(values.hour, "hour")),
    minute: to_integer(values.minute, "minute"),
  };
}

/**
 * Convert local calendar fields to an absolute instant.
 *
 * A local time that falls in a DST gap or repeated hour is rejected instead
 * of silently selecting one occurrence. That ambiguity must reach the caller
 * as unresolved input rather than becoming a proposed booking time.
 *
 * Args:
 *   parts: Local calendar fields to convert.
 *   timezone: Valid IANA timezone identifier.
 *
 * Returns:
 *   ISO instant, or undefined when the local time is nonexistent or repeated.
 */
export function local_datetime_to_instant(
  parts: LocalDateTimeParts,
  timezone: string,
): string | undefined {
  if (!is_valid_timezone(timezone)) throw new RangeError("timezone must be a valid IANA name");
  const desired_utc_ms = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
  );
  let candidate_ms = desired_utc_ms;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const observed = get_local_datetime_parts(new Date(candidate_ms), timezone);
    const observed_utc_ms = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
    );
    const adjustment = desired_utc_ms - observed_utc_ms;
    candidate_ms += adjustment;
    if (adjustment === 0) break;
  }

  const matching_candidates = [-3, -1, 0, 1, 3]
    .map((offset_hours) => candidate_ms + offset_hours * 3_600_000)
    .filter((possible_ms) => same_local_parts(possible_ms, desired_utc_ms, timezone));
  const unique_candidates = [...new Set(matching_candidates)];
  if (unique_candidates.length !== 1) return undefined;
  return new Date(unique_candidates[0]).toISOString();
}

/** Return a date string after adding a whole number of local calendar days. */
export function add_days_to_date(date: string, days: number): string {
  const [year, month, day] = parse_date_string(date);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return format_date(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

/** Return the UTC weekday index for a date string, with Sunday as zero. */
export function weekday_index_for_date(date: string): number {
  const [year, month, day] = parse_date_string(date);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Return a zero-padded YYYY-MM-DD date string. */
export function format_date(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Return a zero-padded HH:mm local time string. */
export function format_time(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function same_local_parts(candidate_ms: number, desired_utc_ms: number, timezone: string): boolean {
  const observed = get_local_datetime_parts(new Date(candidate_ms), timezone);
  const observed_utc_ms = Date.UTC(
    observed.year,
    observed.month - 1,
    observed.day,
    observed.hour,
    observed.minute,
  );
  return observed_utc_ms === desired_utc_ms;
}

function normalize_hour(hour: number): number {
  return hour === 24 ? 0 : hour;
}

function parse_date_string(date: string): [number, number, number] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) throw new RangeError("date must use YYYY-MM-DD");
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])] as [number, number, number];
  if (!is_valid_date_parts(...parts)) throw new RangeError("date must be a real calendar date");
  return parts;
}

function is_valid_date_parts(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function to_integer(value: string | undefined, field_name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new RangeError(`invalid ${field_name}`);
  return parsed;
}
