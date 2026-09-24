import { describe, expect, it, vi } from "vitest";
import { handle_voice_note } from "../src/voice_note_flow.js";
import type { CalendarPort } from "../src/tools/calendar.js";

const NOW = new Date("2026-09-24T10:00:00+07:00");
const OPTIONS = { now: NOW, timezone: "Asia/Jakarta" } as const;

describe("handle_voice_note", () => {
  it("emits a consent card for tomorrow afternoon", () => {
    const result = handle_voice_note("besok sore", OPTIONS);

    expect(result.kind).toBe("consent_card");
    expect(result.next_action).toBe("await_confirmation");
    if (result.kind === "consent_card") {
      expect(result.card).toMatchObject({
        day: "Friday",
        date: "2026-09-25",
        time: "15:00",
        timezone: "Asia/Jakarta",
        requires_confirmation: true,
      });
    }
  });

  it("asks one clarification question for an ambiguous time", () => {
    const result = handle_voice_note("jam 4", OPTIONS);

    expect(result.kind).toBe("clarification");
    expect(result.next_action).toBe("await_clarification");
    if (result.kind === "clarification") {
      expect(result.question).toBe("Which day should I use for that time?");
      expect(result.question.match(/\?/g)).toHaveLength(1);
      expect(result.intent.unresolved).toEqual(["date"]);
    }
  });

  it("routes cancellation to the existing cancel flow", () => {
    expect(handle_voice_note("batal", OPTIONS)).toMatchObject({
      kind: "cancel",
      next_action: "cancel",
      intent: { intent: "cancel" },
    });
  });

  it("does not write to the calendar before a confirmation tap", () => {
    const calendar = {
      confirm_hold: vi.fn(),
      hold_slot: vi.fn(),
    } as unknown as CalendarPort;

    const result = handle_voice_note("besok sore", OPTIONS);

    expect(result.kind).toBe("consent_card");
    expect(calendar.confirm_hold).not.toHaveBeenCalled();
    expect(calendar.hold_slot).not.toHaveBeenCalled();
  });
});
