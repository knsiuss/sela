/** Build safe, channel-neutral reply drafts from appointment graph state. */

import { build_reconfirm_buttons, build_slot_option_buttons } from "../confirm_flow.js";
import { build_operator_reply } from "../handoff.js";
import type { AppointmentStateType, TimeSlot } from "../state.js";
import type { OutboundDraft, OutboundDraftButton } from "../worker/process_job.js";

/**
 * Render one graph result into customer-safe outbound drafts.
 *
 * The builder never infers confirmation from a completed graph. A confirmation
 * message is emitted only when the caller supplies both a hold and the explicit
 * customer-confirmed state flag.
 *
 * @param state - Final state for one inbound turn.
 * @param to - Transient recipient phone, consumed only by the sender boundary.
 * @returns One or more channel-neutral drafts.
 */
export function build_outbound_drafts(
  state: AppointmentStateType,
  to: string,
): OutboundDraft[] {
  if (state.needs_human) {
    return [
      {
        to,
        message_type: "text",
        text: build_operator_reply(),
        buttons: [operator_button()],
      },
    ];
  }

  if (state.hold !== undefined) {
    if (state.customer_confirmed === true && state.done) {
      return [{ to, message_type: "text", text: "Your appointment change is confirmed." }];
    }
    return [
      {
        to,
        message_type: "text",
        text: "Please confirm the appointment change using one of the options below.",
        buttons: reconfirm_buttons(),
      },
    ];
  }

  const offered_slots = state.candidate_slots.slice(0, 2);
  if (offered_slots.length > 0 && (state.intent === "reschedule" || state.intent === "book")) {
    return [
      {
        to,
        message_type: "text",
        text: build_slot_offer_text(offered_slots),
        buttons: slot_buttons(offered_slots.length),
      },
    ];
  }

  if (state.intent === "confirm") {
    return [
      {
        to,
        message_type: "text",
        text: "Please choose an appointment time before confirming.",
      },
    ];
  }

  if (state.intent === "cancel") {
    return [
      {
        to,
        message_type: "text",
        text: "Please tell our team which appointment you want to cancel.",
        buttons: [operator_button()],
      },
    ];
  }

  return [
    {
      to,
      message_type: "text",
      text: state.done
        ? "We received your request. Our team will follow up with the next step."
        : "We are processing your request.",
    },
  ];
}

function build_slot_offer_text(slots: readonly TimeSlot[]): string {
  const options = slots.map((slot, index) => `${index + 1}. ${format_slot(slot)}`).join("\n");
  return `Available appointment times:\n${options}\nPlease choose an option.`;
}

function format_slot(slot: TimeSlot): string {
  return `${slot.start_iso} to ${slot.end_iso}`;
}

function slot_buttons(slot_count: number): OutboundDraftButton[] {
  return build_slot_option_buttons(slot_count).map((button) => ({
    id: button.button_id,
    label: button.label,
    payload: button.button_id,
  }));
}

function reconfirm_buttons(): OutboundDraftButton[] {
  return build_reconfirm_buttons().map((button) => ({
    id: button.button_id,
    label: button.label,
    payload: button.button_id,
  }));
}

function operator_button(): OutboundDraftButton {
  return { id: "operator", label: "Talk to operator", payload: "operator" };
}
