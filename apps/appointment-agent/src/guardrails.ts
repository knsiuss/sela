import type { AppointmentStateType, Intent } from "./state.js";

const CONFIDENCE_THRESHOLD = Number(process.env.CONFIDENCE_THRESHOLD ?? 0.7);

// D-05 gates: a human decides when the action is irreversible, carries
// liability, moves money, identity is unverified, or ambiguity is high.
const HUMAN_KEYWORDS =
  /(komplain|keberatan|darurat|emergency|sakit banget|refund|bayar|tagih|discount|diskon|asuransi|insurance|pengacara|lawyer)/i;

export interface ClassifiedIntent {
  intent: Intent;
  confidence: number;
}

/**
 * Classify a raw customer message into a booking intent.
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
  return { intent: "unknown", confidence: 0.3 };
}

export interface HandoffDecision {
  escalate: boolean;
  reason?: string;
}

/**
 * Decide whether a conversation must be handed to a human.
 *
 * Sensitive keywords always escalate, even with a clear intent,
 * because liability outranks automation savings.
 *
 * Args:
 *   state: Current appointment state with intent and confidence filled.
 *
 * Returns:
 *   Escalation flag plus a machine-readable reason for the audit log.
 */
export function needs_human(state: AppointmentStateType): HandoffDecision {
  if (HUMAN_KEYWORDS.test(state.raw_message)) {
    return { escalate: true, reason: "sensitive-or-liability-keyword" };
  }
  if (state.confidence < CONFIDENCE_THRESHOLD) {
    return { escalate: true, reason: `low-confidence:${state.confidence}` };
  }
  if (state.intent === "unknown") {
    return { escalate: true, reason: "unknown-intent" };
  }
  return { escalate: false };
}
