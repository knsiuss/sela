/**
 * Timestamp presentation contract.
 *
 * Two things are load-bearing here, so they are asserted rather than assumed:
 * the output is stable regardless of environment, and it never renders a run of
 * four or more digits, which `test/redaction.test.tsx` treats as a potential
 * phone number or confirmation code.
 */

import { describe, expect, it } from "vitest";
import {
  UNKNOWN_TIME,
  format_datetime,
  format_day,
  format_time,
} from "../src/components/format_datetime";

/** Instants chosen to cover midnight, afternoon, and a date rollover. */
const INSTANTS: readonly string[] = [
  "2026-03-02T09:00:00.000Z",
  "2026-03-02T00:05:00.000Z",
  "2026-03-02T23:45:00.000Z",
  "2026-03-11T23:59:00.000Z",
  "2026-12-31T12:00:00.000Z",
];

describe("format_datetime", () => {
  it("renders a weekday, day, month and 24-hour clock", () => {
    expect(format_datetime("2026-03-02T09:00:00.000Z")).toBe("Mon 02 Mar, 09:00");
  });

  it("renders midnight as 00 hours rather than 12 or 24", () => {
    expect(format_datetime("2026-03-02T00:05:00.000Z")).toBe("Mon 02 Mar, 00:05");
  });

  it("is stable across repeated calls, so server and client render alike", () => {
    const first = INSTANTS.map(format_datetime);
    const second = INSTANTS.map(format_datetime);
    expect(first).toEqual(second);
  });

  it("never emits a four-digit run, which the redaction contract forbids", () => {
    for (const instant of INSTANTS) {
      expect(format_datetime(instant).match(/\d{4,}/gu)).toBeNull();
      expect(format_day(instant).match(/\d{4,}/gu)).toBeNull();
      expect(format_time(instant).match(/\d{4,}/gu)).toBeNull();
    }
  });
});

describe("format_day and format_time", () => {
  it("drops the clock for a date-only stamp", () => {
    expect(format_day("2026-03-02T09:00:00.000Z")).toBe("Mon 02 Mar");
  });

  it("drops the date for a clock-only stamp", () => {
    expect(format_time("2026-03-02T09:00:00.000Z")).toBe("09:00");
  });
});

describe("unparseable instants", () => {
  it("degrades to a visible placeholder instead of NaN or a thrown error", () => {
    for (const invalid of ["", "not-a-date", "2026-13-45T99:99:99Z"]) {
      expect(format_datetime(invalid)).toBe(UNKNOWN_TIME);
      expect(format_day(invalid)).toBe(UNKNOWN_TIME);
      expect(format_time(invalid)).toBe(UNKNOWN_TIME);
    }
  });
});