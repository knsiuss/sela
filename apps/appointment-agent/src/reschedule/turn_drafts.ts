/** Customer-safe draft rendering for persisted reschedule session phases. */

import { build_reconfirm_buttons, build_slot_option_buttons } from "../confirm_flow.js";
import { build_operator_reply } from "../handoff.js";
import { build_interactive_draft, build_outbound_drafts } from "../outbound/reply_builder.js";
import type { AppointmentStateType, TimeSlot } from "../state.js";
import type { OutboundDraft, OutboundDraftButton } from "../worker/process_job.js";
import { format_reschedule_button_action } from "./button_actions.js";
import type { RescheduleSession } from "./session_model.js";

/** One renderer input selected by the turn processor's state decision. */
export type RescheduleTurnDraftInput =
  | { kind: "offer"; session: RescheduleSession }
  | { kind: "reconfirm"; session: RescheduleSession }
  | { kind: "confirmed"; session: RescheduleSession }
  | { kind: "cancelled"; session: RescheduleSession }
  | { kind: "handoff" }
  | { kind: "change_day" }
  | { kind: "rejected" }
  | { kind: "graph"; state: AppointmentStateType };

/**
 * Render one validated phase decision without performing calendar operations.
 *
 * A confirmed text is emitted only for a persisted `confirmed` session after
 * the processor awaited CalendarPort.confirm_hold. No draft sets the local
 * `customer_confirmed` hint or requests a state-changing sender operation.
 *
 * @param input - Phase or graph result selected by the processor.
 * @param to - Transient recipient used only by the sender boundary.
 * @returns One channel-neutral outbound draft.
 */
export function build_reschedule_turn_draft(
  input: RescheduleTurnDraftInput,
  to: string,
): OutboundDraft {
  if (input.kind === "offer") return offer_draft(input.session, to);
  if (input.kind === "reconfirm") return reconfirm_draft(input.session, to);
  if (input.kind === "confirmed") return confirmed_draft(to);
  if (input.kind === "cancelled") return cancelled_draft(to);
  if (input.kind === "handoff") return handoff_draft(to);
  if (input.kind === "change_day") return plain_draft(to, "Please tell us another day you prefer.");
  if (input.kind === "rejected") return rejected_draft(to);
  return build_outbound_drafts(input.state, to)[0] ?? plain_draft(to, "We are processing your request.");
}

function offer_draft(session: RescheduleSession, to: string): OutboundDraft {
  const slots = session.candidate_slots.slice(0, 2);
  if (slots.length === 0) {
    return plain_draft(to, "No appointment times are available right now. Please try again later.");
  }
  return build_interactive_draft({
    to,
    text: slot_offer_text(slots),
    buttons: generation_bound_offer_buttons(slots.length, session.offer_generation),
  });
}

function reconfirm_draft(session: RescheduleSession, to: string): OutboundDraft {
  return build_interactive_draft({
    to,
    text: "Please confirm the appointment change using one of the options below.",
    buttons: generation_bound_reconfirm_buttons(session.offer_generation),
  });
}

function generation_bound_offer_buttons(
  slot_count: number,
  generation: number,
): OutboundDraftButton[] {
  return build_slot_option_buttons(slot_count).map((button) => {
    const action = button.button_id === "change_day"
      ? { kind: "change_day" as const, generation }
      : {
          kind: "pick_slot" as const,
          option: Number(button.button_id.slice("pick_slot_".length)),
          generation,
        };
    const button_id = format_reschedule_button_action(action);
    return { id: button_id, label: button.label, payload: button_id };
  });
}

function generation_bound_reconfirm_buttons(generation: number): OutboundDraftButton[] {
  return build_reconfirm_buttons().map((button) => {
    const action = {
      kind: button.button_id as "confirm_move" | "confirm_cancel",
      generation,
    };
    const button_id = format_reschedule_button_action(action);
    return { id: button_id, label: button.label, payload: button_id };
  });
}

function slot_offer_text(slots: readonly TimeSlot[]): string {
  const options = slots.map((slot, index) => `${index + 1}. ${slot.start_iso} to ${slot.end_iso}`).join("\n");
  return `Available appointment times:\n${options}\nPlease choose an option.`;
}

function handoff_draft(to: string): OutboundDraft {
  return build_interactive_draft({
    to,
    text: build_operator_reply(),
    buttons: [{ id: "operator", label: "Talk to operator", payload: "operator" }],
  });
}

function confirmed_draft(to: string): OutboundDraft {
  return plain_draft(to, "Your appointment change is confirmed.");
}

function cancelled_draft(to: string): OutboundDraft {
  return plain_draft(to, "The held appointment time was released. No appointment change was made.");
}

function rejected_draft(to: string): OutboundDraft {
  return plain_draft(to, "This appointment option is no longer available. Please request new times to continue.");
}

function plain_draft(to: string, text: string): OutboundDraft {
  return { to, message_type: "text", text };
}
