const MINUTES_PER_DAY = 1_440;
const MILLISECONDS_PER_MINUTE = 60_000;

/** Configured working-hour window; omitted day means every day. */
export interface GoogleCalendarWorkingHours {
  start_time?: string;
  end_time?: string;
  start_hour?: number;
  end_hour?: number;
  days_of_week?: readonly number[];
  time_zone?: string;
}

/** One or more working-hour windows for slot generation. */
export type GoogleCalendarWorkingHoursConfig =
  | GoogleCalendarWorkingHours
  | readonly GoogleCalendarWorkingHours[];

interface NormalizedWorkingWindow {
  days_of_week: readonly number[] | undefined;
  start_minutes: number;
  end_minutes: number;
}

export interface WorkingSlotWindow {
  start_ms: number;
  end_ms: number;
}

/**
 * Divide configured working hours into service-duration windows.
 *
 * Google freebusy supplies busy blocks only. This function turns those blocks
 * into an approximation by dividing working hours by the configured service
 * duration; it does not claim provider-level slot precision or resolve all
 * daylight-saving edge cases. Callers must still filter overlapping busy blocks.
 */
export function build_working_slot_windows(options: WorkingSlotOptions): WorkingSlotWindow[] {
  const window_start_ms = parse_timestamp(options.window_start_iso, "window_start_iso");
  const window_end_ms = parse_timestamp(options.window_end_iso, "window_end_iso");
  if (window_end_ms <= window_start_ms) throw new RangeError("availability window must have positive duration");
  const service_duration_minutes = positive_integer(options.service_duration_minutes, "service_duration_minutes");
  const interval_minutes = positive_integer(
    options.slot_interval_minutes ?? service_duration_minutes,
    "slot_interval_minutes",
  );
  if (interval_minutes < service_duration_minutes) {
    throw new RangeError("slot_interval_minutes must be at least service_duration_minutes");
  }
  const normalized = normalize_working_hours(options.working_hours);
  const time_zone = options.time_zone ?? normalized.time_zone ?? "UTC";
  const formatter = create_time_zone_formatter(time_zone);
  const first_day = local_date(formatter, new Date(window_start_ms));
  const last_day = local_date(formatter, new Date(window_end_ms));
  const windows: WorkingSlotWindow[] = [];

  for (let day_ms = Date.UTC(first_day.year, first_day.month - 1, first_day.day); day_ms <= Date.UTC(last_day.year, last_day.month - 1, last_day.day); day_ms += 86_400_000) {
    const day_of_week = new Date(day_ms).getUTCDay();
    for (const working_window of normalized.windows) {
      if (working_window.days_of_week !== undefined && !working_window.days_of_week.includes(day_of_week)) continue;
      append_window_candidates(windows, day_ms, working_window, interval_minutes, service_duration_minutes, window_start_ms, window_end_ms, time_zone, formatter);
    }
  }
  return windows;
}

interface WorkingSlotOptions {
  window_start_iso: string;
  window_end_iso: string;
  working_hours: GoogleCalendarWorkingHoursConfig;
  service_duration_minutes: number;
  slot_interval_minutes?: number;
  time_zone?: string;
}

function append_window_candidates(
  target: WorkingSlotWindow[],
  local_day_ms: number,
  working_window: NormalizedWorkingWindow,
  interval_minutes: number,
  service_duration_minutes: number,
  window_start_ms: number,
  window_end_ms: number,
  time_zone: string,
  formatter: Intl.DateTimeFormat,
): void {
  const day = new Date(local_day_ms);
  const start_ms = local_minutes_to_utc(
    { year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate(), minute: working_window.start_minutes },
    time_zone,
    formatter,
  );
  const end_ms = local_minutes_to_utc(
    { year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate(), minute: working_window.end_minutes },
    time_zone,
    formatter,
  );
  for (let start = start_ms; start + service_duration_minutes * MILLISECONDS_PER_MINUTE <= end_ms; start += interval_minutes * MILLISECONDS_PER_MINUTE) {
    const candidate_end = start + service_duration_minutes * MILLISECONDS_PER_MINUTE;
    if (start >= window_start_ms && candidate_end <= window_end_ms) {
      target.push({ start_ms: start, end_ms: candidate_end });
    }
  }
}

function normalize_working_hours(config: GoogleCalendarWorkingHoursConfig): {
  time_zone: string | undefined;
  windows: NormalizedWorkingWindow[];
} {
  const entries = Array.isArray(config) ? config : [config];
  if (entries.length === 0 || entries.some((entry) => !is_working_hours_entry(entry))) {
    throw new RangeError("working_hours must contain valid windows");
  }
  const time_zone = entries[0]?.time_zone;
  if (entries.some((entry) => entry.time_zone !== undefined && entry.time_zone !== time_zone)) {
    throw new RangeError("working_hours must use one time_zone");
  }
  const windows = entries.map((entry) => ({
    days_of_week: normalize_days(entry.days_of_week),
    start_minutes: parse_boundary(entry.start_time, entry.start_hour, "start"),
    end_minutes: parse_boundary(entry.end_time, entry.end_hour, "end"),
  }));
  if (windows.some((window) => window.end_minutes <= window.start_minutes)) {
    throw new RangeError("working_hours end must be after start");
  }
  return { time_zone, windows };
}

function is_working_hours_entry(value: unknown): value is GoogleCalendarWorkingHours {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalize_days(days: readonly number[] | undefined): readonly number[] | undefined {
  if (days === undefined) return undefined;
  if (days.length === 0 || days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    throw new RangeError("days_of_week must contain integers from 0 to 6");
  }
  return [...new Set(days)];
}

function parse_boundary(time: string | undefined, hour: number | undefined, boundary: "start" | "end"): number {
  if (time !== undefined) {
    const match = /^(\d{2}):(\d{2})$/.exec(time);
    if (match === null) throw new RangeError(`${boundary} time must use HH:mm`);
    const minutes = Number(match[1]) * 60 + Number(match[2]);
    if (minutes < 0 || minutes > MINUTES_PER_DAY) throw new RangeError(`${boundary} time is invalid`);
    return minutes;
  }
  if (hour !== undefined) {
    const maximum = boundary === "end" ? 24 : 23;
    if (!Number.isInteger(hour) || hour < 0 || hour > maximum) {
      throw new RangeError(`${boundary}_hour is invalid`);
    }
    return hour * 60;
  }
  throw new RangeError(`${boundary} working-hours boundary is required`);
}

function create_time_zone_formatter(time_zone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: time_zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    throw new RangeError("time_zone must be a valid IANA time zone");
  }
}

function local_date(formatter: Intl.DateTimeFormat, date: Date): { year: number; month: number; day: number } {
  const parts = formatter.formatToParts(date);
  return {
    year: Number(parts.find((part) => part.type === "year")?.value),
    month: Number(parts.find((part) => part.type === "month")?.value),
    day: Number(parts.find((part) => part.type === "day")?.value),
  };
}

function local_minutes_to_utc(
  date: { year: number; month: number; day: number; minute: number },
  time_zone: string,
  formatter: Intl.DateTimeFormat,
): number {
  const naive_ms = Date.UTC(date.year, date.month - 1, date.day, 0, date.minute);
  let utc_ms = naive_ms - time_zone_offset_ms(new Date(naive_ms), formatter);
  utc_ms = naive_ms - time_zone_offset_ms(new Date(utc_ms), formatter);
  return utc_ms;
}

function time_zone_offset_ms(date: Date, formatter: Intl.DateTimeFormat): number {
  const parts = formatter.formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const rendered_ms = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
  );
  return rendered_ms - date.getTime();
}

function parse_timestamp(value: string, field_name: string): number {
  const timestamp_ms = Date.parse(value);
  if (!Number.isFinite(timestamp_ms)) throw new TypeError(`${field_name} must be a valid ISO timestamp`);
  return timestamp_ms;
}

function positive_integer(value: number, field_name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${field_name} must be a positive integer`);
  return value;
}
