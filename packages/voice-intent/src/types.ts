/** Public contracts for transcript-only voice-note rescheduling. */

/** Intent detected from a voice-note transcript. */
export type VoiceNoteIntentType = "reschedule" | "cancel" | "unknown";

/** Canonical time proposal ready to be shown in a confirmation card. */
export interface ProposedSlot {
  /** English weekday derived in the proposal's timezone. */
  day: string;
  /** Local calendar date in YYYY-MM-DD form. */
  date: string;
  /** Local 24-hour clock time in HH:mm form. */
  time: string;
  /** IANA timezone, for example Asia/Jakarta. */
  timezone: string;
  /** Absolute start instant serialized as an ISO timestamp. */
  start_iso: string;
}

/** Structured result of parsing one untrusted transcript string. */
export interface VoiceNoteIntent {
  /** Detected action; incomplete proposals remain reschedule intents. */
  intent: VoiceNoteIntentType;
  /** Confidence in the intent, from 0 through 1. */
  confidence: number;
  /** Complete proposal, present only when both date and time are resolved. */
  proposed_slot?: ProposedSlot;
  /** Missing or conflicting fields that must be clarified before a card. */
  unresolved: string[];
}

/** One deterministic action on a consent card. */
export interface ConsentCardButton {
  button_id: "confirm" | "other_day" | "cancel";
  label: "Confirm" | "Other day" | "Cancel";
}

/** Canonical, customer-facing confirmation card for a proposed slot. */
export interface ConsentCard {
  type: "consent_card";
  day: string;
  date: string;
  time: string;
  timezone: string;
  /** Safety invariant: a card must be explicitly tapped before any write. */
  requires_confirmation: true;
  buttons: ConsentCardButton[];
}
