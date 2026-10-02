/**
 * PII scrubbing boundary tests.
 *
 * The port's redaction guarantee is only as strong as this file, so it asserts
 * both what is masked and what survives, plus the bound that keeps a
 * pathological message from reaching a provider at unbounded size.
 */

import { describe, expect, it } from "vitest";
import {
  MAX_REDACTED_TEXT_CHARS,
  REDACTED_EMAIL,
  REDACTED_PHONE,
  REDACTED_SECRET,
  contains_residual_pii,
  redact_pii,
} from "../src/index.js";

describe("redact_pii", () => {
  it("masks an Indonesian phone number in local and international form", () => {
    expect(redact_pii("hubungi 081234567890")).toBe(`hubungi ${REDACTED_PHONE}`);
    expect(redact_pii("call +62 812-3456-7890")).toContain(REDACTED_PHONE);
  });

  it("masks an email address", () => {
    expect(redact_pii("mail patient@example.com")).toBe(`mail ${REDACTED_EMAIL}`);
  });

  it("masks a secret-looking assignment", () => {
    const scrubbed = redact_pii("api_key=sk-live-abc123 and password: hunter2");
    expect(scrubbed).toContain(REDACTED_SECRET);
    expect(scrubbed).not.toContain("sk-live-abc123");
    expect(scrubbed).not.toContain("hunter2");
  });

  it("masks every occurrence rather than only the first", () => {
    const scrubbed = redact_pii("081234567890 and 081298765432");
    expect(scrubbed.split(REDACTED_PHONE).length - 1).toBe(2);
    expect(contains_residual_pii(scrubbed)).toBe(false);
  });

  it("leaves ordinary text untouched", () => {
    expect(redact_pii("mau reschedule besok")).toBe("mau reschedule besok");
  });

  it("bounds the result to the outbound limit", () => {
    const scrubbed = redact_pii("x".repeat(MAX_REDACTED_TEXT_CHARS + 500));
    expect(scrubbed.length).toBe(MAX_REDACTED_TEXT_CHARS);
  });
});

describe("contains_residual_pii", () => {
  it("reports a masked string as safe", () => {
    expect(contains_residual_pii(redact_pii("call 081234567890"))).toBe(false);
  });

  it("detects an unmasked phone number so a bypass cannot pass silently", () => {
    expect(contains_residual_pii("call 081234567890")).toBe(true);
  });

  it("detects an unmasked email address", () => {
    expect(contains_residual_pii("write to patient@example.com")).toBe(true);
  });

  it("does not flag a short number as a phone number", () => {
    expect(contains_residual_pii("pilih slot 2 jam 10")).toBe(false);
  });
});
