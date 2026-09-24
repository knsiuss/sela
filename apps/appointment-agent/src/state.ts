import { Annotation } from "@langchain/langgraph";

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
