/** Pure transcript parsing for Indonesian and code-switched voice notes. */

import {
  add_days_to_date,
  format_date,
  format_time,
  get_local_datetime_parts,
  local_datetime_to_instant,
  weekday_index_for_date,
} from "./datetime.js";
import type { ProposedSlot, VoiceNoteIntent } from "./types.js";

/** Default business timezone used when the caller has no tenant context. */
export const DEFAULT_TIMEZONE = "Asia/Jakarta";

/** Matches the app's bounded free-text boundary before parsing. */
export const MAX_TRANSCRIPT_CHARS = 4096;

const CANCEL_PATTERN = /\b(?:batal|batalkan|cancel|cancellation|gak jadi|nggak jadi|tidak jadi)\b/u;
const RESCHEDULE_PATTERN =
  /\b(?:reschedule|reschedul|jadwal ulang|geser|pindah|ganti (?:jadwal|hari)|bisa|boleh|mau|ingin|tolong)\b/u;
const RELATIVE_DAYS: Record<string, number> = {
  "hari ini": 0,
  besok: 1,
  lusa: 2,
};
const WEEKDAYS: Record<string, number> = {
  minggu: 0,
  senin: 1,
  selasa: 2,
  rabu: 3,
  kamis: 4,
  jumat: 5,
  sabtu: 6,
};
const PERIOD_HOURS: Record<string, number> = {
  pagi: 9,
  siang: 12,
  sore: 15,
  malam: 19,
};
const CANCEL_CONFIDENCE = 0.98;
const BASE_CONFIDENCE = 0.35;
const INTENT_CUE_CONFIDENCE = 0.25;
const DATE_CONFIDENCE = 0.2;
const TIME_CONFIDENCE = 0.2;
const UNRESOLVED_CONFIDENCE_PENALTY = 0.15;
const MAX_CONFIDENCE = 0.99;

/** Configuration for deterministic transcript parsing. */
export interface VoiceNoteParserOptions {
  /** Reference instant; defaults to the current instant. */
  now?: Date;
  /** IANA timezone used to resolve relative dates; defaults to Asia/Jakarta. */
  timezone?: string;
}

interface DateResult {
  date?: string;
  unresolved: boolean;
}

interface TimeResult {
  time?: string;
  unresolved: boolean;
}

interface NumericTime {
  hour: number;
  minute: number;
}

/**
 * Parse a voice-note transcript without reading audio or performing I/O.
 *
 * Relative dates and common Indonesian time expressions are converted to a
 * canonical proposal. Missing or conflicting fields are returned in
 * `unresolved`; the parser never invents a date or time to fill them.
 *
 * Args:
 *   transcript: Untrusted text produced by a speech-to-text boundary.
 *   options: Optional reference date and tenant timezone. A Date may also be
 *     passed as the second argument for a compact positional call.
 *   positional_timezone: Timezone when the second argument is a Date.
 *
 * Returns:
 *   A structured intent with a complete proposed slot only when both date and
 *   time are resolved.
 */
export function parse_voice_note_transcript(
  transcript: string,
  options: VoiceNoteParserOptions | Date = {},
  positional_timezone?: string,
): VoiceNoteIntent {
  if (typeof transcript !== "string") throw new TypeError("transcript must be a string");
  if (transcript.length > MAX_TRANSCRIPT_CHARS) throw new RangeError("transcript is too long");
  const resolved_options = resolve_options(options, positional_timezone);
  const now = resolved_options.now ?? new Date();
  const timezone = resolved_options.timezone ?? DEFAULT_TIMEZONE;
  if (Number.isNaN(now.getTime())) throw new RangeError("now must be a valid date");
  const text = normalize_transcript(transcript);
  if (CANCEL_PATTERN.test(text)) {
    return { intent: "cancel", confidence: CANCEL_CONFIDENCE, unresolved: [] };
  }

  const date_result = extract_date(text, now, timezone);
  const time_result = extract_time(text);
  const has_intent_cue = RESCHEDULE_PATTERN.test(text);
  if (!has_intent_cue && date_result.date === undefined && time_result.time === undefined) {
    return { intent: "unknown", confidence: 0, unresolved: ["intent"] };
  }

  const unresolved = collect_unresolved(date_result, time_result);
  const confidence = calculate_confidence(has_intent_cue, date_result.date !== undefined, time_result.time !== undefined, unresolved.length);
  if (date_result.date === undefined || time_result.time === undefined) {
    return { intent: "reschedule", confidence, unresolved };
  }
  const proposed_slot = build_proposed_slot(date_result.date, time_result.time, timezone);
  if (proposed_slot === undefined) {
    return { intent: "reschedule", confidence, unresolved: ["timezone"] };
  }
  return { intent: "reschedule", confidence, proposed_slot, unresolved: [] };
}

/**
 * Alias for callers that use the transcript terminology.
 *
 * Args:
 *   transcript: Untrusted transcript text.
 *   options: Optional reference date and timezone.
 *   positional_timezone: Timezone when the second argument is a Date.
 *
 * Returns:
 *   The same structured result as `parse_voice_note_transcript`.
 */
export const parse_transcript = parse_voice_note_transcript;

/**
 * Alias for integrations that call the input a voice note.
 *
 * Args:
 *   transcript: Untrusted transcript text.
 *   options: Optional reference date and timezone.
 *   positional_timezone: Timezone when the second argument is a Date.
 *
 * Returns:
 *   The same structured result as `parse_voice_note_transcript`.
 */
export const parse_voice_note = parse_voice_note_transcript;

function resolve_options(
  options: VoiceNoteParserOptions | Date,
  positional_timezone?: string,
): VoiceNoteParserOptions {
  if (options instanceof Date) return { now: options, timezone: positional_timezone };
  if (options === null || typeof options !== "object") {
    throw new TypeError("parser options must be an object or Date");
  }
  return options;
}

function normalize_transcript(transcript: string): string {
  return transcript
    .normalize("NFKC")
    .toLocaleLowerCase("id-ID")
    .replace(/[’'`´]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function extract_date(text: string, now: Date, timezone: string): DateResult {
  const local_parts = get_local_datetime_parts(now, timezone);
  const today = format_date(local_parts.year, local_parts.month, local_parts.day);
  const candidates: string[] = [];
  for (const relative_match of text.matchAll(/\b(hari ini|besok|lusa)\b/gu)) {
    candidates.push(add_days_to_date(today, RELATIVE_DAYS[relative_match[1]]));
  }

  const weekday_pattern = /\b(minggu|senin|selasa|rabu|kamis|jumat|sabtu)(?:\s+(?:dpn|depan))?\b/gu;
  for (const weekday_match of text.matchAll(weekday_pattern)) {
    const is_ambiguous_week = weekday_match[1] === "minggu" && /\bminggu\s+(?:ini|depan|besok)\b/u.test(text);
    if (is_ambiguous_week) continue;
    const target = WEEKDAYS[weekday_match[1]];
    const is_next_week = /dpn|depan/u.test(weekday_match[0]);
    const current_weekday = weekday_index_for_date(today);
    const day_delta = is_next_week ? ((target - current_weekday + 7) % 7) || 7 : (target - current_weekday + 7) % 7;
    candidates.push(add_days_to_date(today, day_delta));
  }

  const unique_candidates = [...new Set(candidates)];
  if (unique_candidates.length > 1) return { unresolved: true };
  if (unique_candidates.length === 1) return { date: unique_candidates[0], unresolved: false };
  return { unresolved: true };
}

function extract_time(text: string): TimeResult {
  const matches: NumericTime[] = [];
  const numbered_pattern = /\b(?:jam|pukul)\s*(\d{1,2})(?::(\d{2}))?(?:\s*(pagi|siang|sore|malam))?\b/gu;
  for (const match of text.matchAll(numbered_pattern)) {
    const time = parse_numeric_time(match[1], match[2], match[3]);
    if (time !== undefined) matches.push(time);
  }
  const bare_period_pattern = /\b(\d{1,2})\s*(pagi|siang|sore|malam)\b/gu;
  for (const match of text.matchAll(bare_period_pattern)) {
    const time = parse_numeric_time(match[1], undefined, match[2]);
    if (time !== undefined) matches.push(time);
  }
  const period_pattern = /\b(pagi|siang|sore|malam)\b/gu;
  const has_numeric_period = /\b(?:jam|pukul)\s*\d{1,2}\s*(?:pagi|siang|sore|malam)\b|\b\d{1,2}\s*(?:pagi|siang|sore|malam)\b/u.test(text);
  if (!has_numeric_period) {
    const periods = [...text.matchAll(period_pattern)].map((match) => PERIOD_HOURS[match[1]]);
    for (const hour of periods) matches.push({ hour, minute: 0 });
  }
  const unique_times = new Map(matches.map((time) => [`${time.hour}:${time.minute}`, time]));
  if (unique_times.size > 1) return { unresolved: true };
  if (unique_times.size === 0) return { unresolved: true };
  const time = [...unique_times.values()][0];
  return { time: format_time(time.hour, time.minute), unresolved: false };
}

function parse_numeric_time(
  hour_text: string,
  minute_text: string | undefined,
  period: string | undefined,
): NumericTime | undefined {
  const hour = Number(hour_text);
  const minute = minute_text === undefined ? 0 : Number(minute_text);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return undefined;
  }
  if (period !== undefined) {
    const period_hour = PERIOD_HOURS[period];
    if (period_hour === undefined) return undefined;
    if (hour === 12) return { hour: period === "malam" ? 0 : 12, minute };
    if (hour > 0 && hour < 12) return { hour: period === "pagi" ? hour : hour + 12, minute };
  }
  if (hour >= 1 && hour <= 6) return { hour: hour + 12, minute };
  if (hour === 12) return undefined;
  return { hour, minute };
}

function collect_unresolved(date_result: DateResult, time_result: TimeResult): string[] {
  const unresolved: string[] = [];
  if (date_result.unresolved || date_result.date === undefined) unresolved.push("date");
  if (time_result.unresolved || time_result.time === undefined) unresolved.push("time");
  return unresolved;
}

function calculate_confidence(
  has_intent_cue: boolean,
  has_date: boolean,
  has_time: boolean,
  unresolved_count: number,
): number {
  let confidence = BASE_CONFIDENCE;
  if (has_intent_cue) confidence += INTENT_CUE_CONFIDENCE;
  if (has_date) confidence += DATE_CONFIDENCE;
  if (has_time) confidence += TIME_CONFIDENCE;
  if (unresolved_count > 0) confidence -= UNRESOLVED_CONFIDENCE_PENALTY;
  return Math.round(Math.min(MAX_CONFIDENCE, Math.max(0, confidence)) * 100) / 100;
}

function build_proposed_slot(date: string, time: string, timezone: string): ProposedSlot | undefined {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const [hour, minute] = time.split(":").map(Number) as [number, number];
  const start_iso = local_datetime_to_instant({ year, month, day, hour, minute }, timezone);
  if (start_iso === undefined) return undefined;
  const day_name = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "long" }).format(
    new Date(start_iso),
  );
  return { day: day_name, date, time, timezone, start_iso };
}
