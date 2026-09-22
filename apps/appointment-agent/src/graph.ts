import { StateGraph, START, END, interrupt } from "@langchain/langgraph";
import { AppointmentState, type AppointmentStateType } from "./state.js";
import { classify_intent, needs_human } from "./guardrails.js";
import type { CalendarPort } from "./tools/calendar.js";

const HOLD_TTL_SECONDS = Number(process.env.HOLD_TTL_SECONDS ?? 300);

function parse_message(state: AppointmentStateType): Partial<AppointmentStateType> {
  const { intent, confidence } = classify_intent(state.raw_message);
  const gate = needs_human({ ...state, intent, confidence });
  return {
    intent,
    confidence,
    needs_human: gate.escalate,
    human_summary: gate.escalate ? `Escalated: ${gate.reason}. Message: ${state.raw_message}` : undefined,
    done: gate.escalate,
  };
}

function offer_slots(calendar: CalendarPort) {
  return async (state: AppointmentStateType): Promise<Partial<AppointmentStateType>> => {
    const now = new Date();
    const window_end = new Date(now.getTime() + 14 * 24 * 3600 * 1000);
    const slots = await calendar.list_slots(now.toISOString(), window_end.toISOString());
    return { candidate_slots: slots.slice(0, 3) };
  };
}

function hold_chosen_slot(calendar: CalendarPort) {
  return async (state: AppointmentStateType): Promise<Partial<AppointmentStateType>> => {
    if (!state.chosen_slot_id) return { done: true };
    const hold = await calendar.hold_slot(state.chosen_slot_id, HOLD_TTL_SECONDS);
    return {
      hold: { hold_id: hold.hold_id, slot_id: state.chosen_slot_id, expires_at_iso: hold.expires_at_iso },
    };
  };
}

// Human-in-the-loop: an irreversible write pauses here until staff approves.
async function confirm_write(
  state: AppointmentStateType,
): Promise<Partial<AppointmentStateType>> {
  const approval = interrupt<unknown, { approved: boolean; note?: string }>({
    question: "Approve calendar write?",
    slot_id: state.chosen_slot_id,
    hold: state.hold,
  });
  if (!approval.approved) {
    return { done: true, human_summary: `Rejected by staff: ${approval.note ?? ""}` };
  }
  return {};
}

function write_calendar(calendar: CalendarPort) {
  return async (state: AppointmentStateType): Promise<Partial<AppointmentStateType>> => {
    if (!state.hold) return { done: true };
    await calendar.confirm_hold(state.hold.hold_id, `${state.conversation_id}:${state.hold.hold_id}`);
    return { done: true };
  };
}

/**
 * Build the reschedule state machine.
 *
 * Flow: parse -> offer -> hold -> confirm (HITL interrupt) -> write.
 * Low-confidence or sensitive conversations end after parse with a handoff summary.
 */
export function build_graph(calendar: CalendarPort) {
  const graph = new StateGraph(AppointmentState)
    .addNode("parse", parse_message)
    .addNode("offer", offer_slots(calendar))
    .addNode("hold", hold_chosen_slot(calendar))
    .addNode("confirm", confirm_write)
    .addNode("write", write_calendar(calendar))
    .addEdge(START, "parse")
    .addConditionalEdges("parse", (state) =>
      state.needs_human || state.intent === "confirm" || state.intent === "cancel" ? END : "offer",
    )
    .addEdge("offer", "hold")
    .addEdge("hold", "confirm")
    .addEdge("confirm", "write")
    .addEdge("write", END);
  return graph.compile();
}
