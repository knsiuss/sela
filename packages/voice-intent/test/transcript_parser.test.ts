import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIMEZONE,
  parse_voice_note_transcript,
  type ProposedSlot,
} from "../src/index.js";

const NOW = new Date("2026-09-24T10:00:00+07:00");

function parse(text: string) {
  return parse_voice_note_transcript(text, { now: NOW, timezone: DEFAULT_TIMEZONE });
}

describe("parse_voice_note_transcript", () => {
  it("extracts a day and keeps a missing time unresolved", () => {
    const intent = parse("pak radiografer bisa kamis?");

    expect(intent.intent).toBe("reschedule");
    expect(intent.unresolved).toContain("time");
    expect(intent.proposed_slot).toBeUndefined();
  });

  it("resolves tomorrow afternoon into a canonical proposal", () => {
    const intent = parse("besok sore");

    expect(intent.unresolved).toEqual([]);
    expect(intent.proposed_slot).toMatchObject({
      day: "Friday",
      date: "2026-09-25",
      time: "15:00",
      timezone: DEFAULT_TIMEZONE,
      start_iso: "2026-09-25T08:00:00.000Z",
    });
  });

  it("resolves next Monday with an explicit afternoon time", () => {
    const intent = parse("senin dpn jam 2 siang");

    expect(intent.proposed_slot).toMatchObject({
      day: "Monday",
      date: "2026-09-28",
      time: "14:00",
    });
  });

  it("resolves the day after tomorrow morning", () => {
    expect(parse("lusa pagi").proposed_slot).toMatchObject({ date: "2026-09-26", time: "09:00" });
  });

  it("leaves conflicting date expressions unresolved", () => {
    const intent = parse("besok lusa pagi");

    expect(intent.unresolved).toContain("date");
    expect(intent.proposed_slot).toBeUndefined();
  });

  it("leaves a week phrase unresolved instead of choosing Sunday", () => {
    const intent = parse("minggu ini jam 4");

    expect(intent.unresolved).toContain("date");
    expect(intent.proposed_slot).toBeUndefined();
  });

  it("leaves a time without a day unresolved instead of guessing", () => {
    const intent = parse("jam 4");

    expect(intent.intent).toBe("reschedule");
    expect(intent.unresolved).toEqual(["date"]);
    expect(intent.proposed_slot).toBeUndefined();
  });

  it("leaves a period without a day unresolved instead of guessing", () => {
    const intent = parse("nanti malam");

    expect(intent.unresolved).toEqual(["date"]);
    expect(intent.proposed_slot).toBeUndefined();
  });

  it("classifies batal as cancellation", () => {
    expect(parse("batal")).toEqual({ intent: "cancel", confidence: 0.98, unresolved: [] });
  });

  it("rejects oversized transcript input before parsing", () => {
    expect(() => parse("x".repeat(4097))).toThrow(RangeError);
  });
});

describe("canonical proposal fixture", () => {
  it("keeps a complete proposal consumable by the card builder", () => {
    const proposal: ProposedSlot = parse("besok sore").proposed_slot as ProposedSlot;
    expect(proposal.date).toBe("2026-09-25");
    expect(proposal.time).toBe("15:00");
  });
});
