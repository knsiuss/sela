import type { AppointmentStateType, Intent } from "./state.js";
import { detect_handoff_reason } from "./handoff.js";

const CONFIDENCE_THRESHOLD = Number(process.env.CONFIDENCE_THRESHOLD ?? 0.7);

export interface ClassifiedIntent {
  intent: Intent;
  confidence: number;
}

/** Greeting vocabulary that is unambiguous enough to answer without a model. */
export const GREETING_PATTERN =
  /^(hi|hai|hey|hello|halo|hola|hei|pagi|siang|sore|malam|assalamualaikum|salam|selamat (pagi|siang|sore|malam)|permisi|bro|dude)\b/;

/**
 * Classify a raw customer message into a booking intent.
 *
 * This stays pure regex on purpose: it is the deterministic fast path, and it
 * is the only producer of the `confirm` and `cancel` intents. Those two gate
 * the customer-confirmation boundary, so no probabilistic classifier may
 * produce them. Ambiguous input returns `unknown` and is escalated exactly as
 * it was before the model fallback existed.
 *
 * Args:
 *   message: Raw customer message, any language mix.
 *
 * Returns:
 *   Intent plus a 0-1 confidence score.
 */
export function classify_intent(message: string): ClassifiedIntent {
  const text = message.toLowerCase();
  if (/^(ya|yes|ok|setuju|confirm|konfirmasi)/.test(text)) return { intent: "confirm", confidence: 0.9 };
  if (/(batal|cancel|gak jadi|nggak jadi)/.test(text)) return { intent: "cancel", confidence: 0.85 };
  if (/(geser|mundur|maju|reschedule|jadwal ulang|pindah|ganti (jadwal|hari|jam))/.test(text)) {
    return { intent: "reschedule", confidence: 0.8 };
  }
  if (/(booking|book|daftar|jadwal|appointment|mau periksa|mau potong)/.test(text)) {
    return { intent: "book", confidence: 0.75 };
  }
  if (GREETING_PATTERN.test(text.trim())) return { intent: "greet", confidence: 0.85 };
  return { intent: "unknown", confidence: 0.3 };
}

export interface HandoffDecision {
  escalate: boolean;
  reason?: string;
}

/**
 * Decide whether a conversation must be handed to a human.
 *
 * Deny-list detection is delegated to handoff.ts, the single policy owner,
 * so keyword additions can never land in only one of two gates. Confidence
 * and unknown-intent checks stay here because they read graph state.
 *
 * Args:
 *   state: Current appointment state with intent and confidence filled.
 *
 * Returns:
 *   Escalation flag plus a machine-readable reason for the audit log.
 */
export function needs_human(state: AppointmentStateType): HandoffDecision {
  const deny_list_reason = detect_handoff_reason(state.raw_message);
  if (deny_list_reason !== undefined) {
    return { escalate: true, reason: deny_list_reason };
  }
  if (state.confidence < CONFIDENCE_THRESHOLD) {
    return { escalate: true, reason: `low-confidence:${state.confidence}` };
  }
  if (state.intent === "unknown") {
    return { escalate: true, reason: "unknown-intent" };
  }
  return { escalate: false };
}
