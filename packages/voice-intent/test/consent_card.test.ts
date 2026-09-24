import { describe, expect, it } from "vitest";
import {
  build_consent_card,
  InvalidConsentCardInputError,
  MAX_CONSENT_BUTTON_LABEL_CHARS,
  parse_voice_note_transcript,
} from "../src/index.js";

const NOW = new Date("2026-09-24T10:00:00+07:00");

describe("build_consent_card", () => {
  it("builds the canonical day, date, time, and timezone card", () => {
    const intent = parse_voice_note_transcript("besok sore", {
      now: NOW,
      timezone: "Asia/Jakarta",
    });
    const card = build_consent_card(intent.proposed_slot!);

    expect(card).toEqual({
      type: "consent_card",
      day: "Friday",
      date: "2026-09-25",
      time: "15:00",
      timezone: "Asia/Jakarta",
      requires_confirmation: true,
      buttons: [
        { button_id: "confirm", label: "Confirm" },
        { button_id: "other_day", label: "Other day" },
        { button_id: "cancel", label: "Cancel" },
      ],
    });
  });

  it("keeps every action label within the WhatsApp limit", () => {
    const intent = parse_voice_note_transcript("kamis jam 4", {
      now: NOW,
      timezone: "Asia/Jakarta",
    });
    const card = build_consent_card(intent.proposed_slot!);

    expect(card.buttons.every((button) => button.label.length <= MAX_CONSENT_BUTTON_LABEL_CHARS)).toBe(true);
  });

  it("rejects an inconsistent proposal rather than rendering a misleading card", () => {
    const intent = parse_voice_note_transcript("besok sore", {
      now: NOW,
      timezone: "Asia/Jakarta",
    });
    const proposal = { ...intent.proposed_slot!, date: "2026-09-24" };

    expect(() => build_consent_card(proposal)).toThrow(InvalidConsentCardInputError);
  });
});
