import { Annotation } from "@langchain/langgraph";
import type { RetainedInboundMessage } from "./agent_types.js";

export type Intent = "confirm" | "cancel" | "reschedule" | "book" | "unknown";

export interface TimeSlot {
  id: string;
  start_iso: string;
  end_iso: string;
  staff?: string;
  resource?: string;
}

export interface SlotHold {
  hold_id: string;
  slot_id: string;
  expires_at_iso: string;
}

// Single writer owns all slot mutations. Nodes never write directly,
// so concurrent conversations cannot double-book the same slot.
export const AppointmentState = Annotation.Root({
  conversation_id: Annotation<string>,
  raw_message: Annotation<string>,
  /** Validated inbound quick-reply action id, when the turn was a button. */
  button_id: Annotation<string | undefined>,
  intent: Annotation<Intent>,
  confidence: Annotation<number>,
  candidate_slots: Annotation<TimeSlot[]>,
  chosen_slot_id: Annotation<string | undefined>,
  hold: Annotation<SlotHold | undefined>,
  /** Only an explicit customer action may advance the calendar write. */
  customer_confirmed: Annotation<boolean>,
  needs_human: Annotation<boolean>,
  human_summary: Annotation<string | undefined>,
  done: Annotation<boolean>,
});

export type AppointmentStateType = typeof AppointmentState.State;

/**
 * Create the existing graph's initial state for one validated inbound turn.
 *
 * @param conversation_id - Tenant-scoped opaque conversation identifier.
 * @param message - Retained text and optional validated button id.
 * @returns Fresh graph state with no choice, hold, confirmation, or handoff.
 */
export function create_initial_appointment_state(
  conversation_id: string,
  message: Pick<RetainedInboundMessage, "text_body" | "button_id">,
): AppointmentStateType {
  return {
    conversation_id,
    raw_message: message.text_body,
    button_id: message.button_id,
    intent: "unknown",
    confidence: 0,
    candidate_slots: [],
    chosen_slot_id: undefined,
    hold: undefined,
    customer_confirmed: false,
    needs_human: false,
    human_summary: undefined,
    done: false,
  };
}
