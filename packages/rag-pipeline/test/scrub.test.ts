/** Unit tests for pre-embed text hygiene. */
import { describe, expect, it } from "vitest";
import {
  UnsafeChunkError,
  assert_chunk_is_safe,
  scrub_pii_from_text,
} from "../src/scrub.js";

describe("scrub_pii_from_text", () => {
  it("masks phone numbers and emails without touching policy wording", () => {
    const scrubbed = scrub_pii_from_text(
      "Call +1-555-010-2030 or front@clinic-a.example about rule 2.",
    );
    expect(scrubbed.includes("+1-555-010-2030")).toBe(false);
    expect(scrubbed.includes("front@clinic-a.example")).toBe(false);
    expect(scrubbed.includes("about rule 2.")).toBe(true);
  });

  it("masks secret assignments", () => {
    const scrubbed = scrub_pii_from_text("connect with api_key: abc123 now");
    expect(scrubbed.includes("abc123")).toBe(false);
  });
});

describe("assert_chunk_is_safe", () => {
  it("rejects private key material", () => {
    expect(() =>
      assert_chunk_is_safe("key:\n-----BEGIN RSA PRIVATE KEY-----"),
    ).toThrow(UnsafeChunkError);
  });

  it("rejects chunks dominated by secret placeholders", () => {
    expect(() =>
      assert_chunk_is_safe("[REDACTED_SECRET] [REDACTED_SECRET] word"),
    ).toThrow(UnsafeChunkError);
  });

  it("accepts ordinary policy text", () => {
    expect(assert_chunk_is_safe("Late cancels need 4h notice.")).toBe(true);
  });
});
