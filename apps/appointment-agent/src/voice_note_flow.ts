/** App boundary for transcript-only voice-note rescheduling. */

import {
  build_consent_card,
  parse_voice_note_transcript,
  type ConsentCard,
  type VoiceNoteIntent,
  type VoiceNoteParserOptions,
} from "@repo/voice-intent";

/** Options supplied by the channel/tenant boundary. */
export type VoiceNoteFlowOptions = VoiceNoteParserOptions | Date;

/** Result of one voice-note turn. */
export type VoiceNoteFlowResult =
  | {
      kind: "consent_card";
      intent: VoiceNoteIntent;
      card: ConsentCard;
      next_action: "await_confirmation";
    }
  | {
      kind: "clarification";
      intent: VoiceNoteIntent;
      question: string;
      next_action: "await_clarification";
    }
  | {
      kind: "cancel";
      intent: VoiceNoteIntent;
      next_action: "cancel";
    };

/**
 * Process a transcript into a safe next step.
 *
 * This handler intentionally has no calendar dependency. A complete proposal
 * only emits a consent card; the existing confirmation flow owns the later
 * write. An incomplete proposal asks one question, and cancellation returns a
 * route marker for the app's cancel flow.
 *
 * Args:
 *   transcript: Untrusted transcript text supplied by the transcription layer.
 *   options: Optional reference date and tenant timezone, or a Date reference.
 *   positional_timezone: Timezone when the second argument is a Date.
 *
 * Returns:
 *   A discriminated result for card emission, clarification, or cancellation.
 *
 * Raises:
 *   InvalidConsentCardInputError: If a parser-produced slot fails canonical
 *     validation, rather than emitting a misleading card.
 */
export function handle_voice_note(
  transcript: string,
  options: VoiceNoteFlowOptions = {},
  positional_timezone?: string,
): VoiceNoteFlowResult {
  const intent = parse_voice_note_transcript(transcript, options, positional_timezone);
  if (intent.intent === "cancel") {
    return { kind: "cancel", intent, next_action: "cancel" };
  }
  if (intent.unresolved.length > 0 || intent.proposed_slot === undefined) {
    return {
      kind: "clarification",
      intent,
      question: build_clarification_question(intent),
      next_action: "await_clarification",
    };
  }
  return {
    kind: "consent_card",
    intent,
    card: build_consent_card(intent.proposed_slot),
    next_action: "await_confirmation",
  };
}

/**
 * Alias used by graph adapters that refer to the handler as a flow.
 *
 * Args:
 *   transcript: Untrusted transcript text.
 *   options: Optional reference date and tenant timezone.
 *
 * Returns:
 *   The same discriminated next-step result as `handle_voice_note`.
 */
export const run_voice_note_flow = handle_voice_note;

/**
 * Build exactly one English clarification question for an unresolved intent.
 *
 * Args:
 *   intent: Parsed intent containing missing field names.
 *
 * Returns:
 *   One question that asks only for the missing scheduling information.
 */
export function build_clarification_question(intent: VoiceNoteIntent): string {
  const missing = new Set(intent.unresolved);
  if (missing.has("date") && !missing.has("time")) {
    return "Which day should I use for that time?";
  }
  if (missing.has("time") && !missing.has("date")) {
    return "What time would you like on that day?";
  }
  return "Which day and time would you like to reschedule to?";
}
