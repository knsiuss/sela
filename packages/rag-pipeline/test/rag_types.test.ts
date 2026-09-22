/** Unit tests for the shared chunk metadata contract. */
import { describe, expect, it } from "vitest";
import { chunk_metadata_schema } from "../src/rag_types.js";

function build_valid_metadata(): Record<string, unknown> {
  return {
    doc_id: "sop_reschedule_v3",
    effective_from: "2026-01-01",
    section: "late_cancel_policy",
    source_uri: "dashboard://clinic_a/sop_reschedule_v3",
    tenant_id: "clinic_a",
    vertical: "dental",
  };
}

describe("chunk_metadata_schema", () => {
  it("applies deployment defaults for locale, model, and activity", () => {
    const parsed = chunk_metadata_schema.parse(build_valid_metadata());
    expect(parsed.locale).toBe("en");
    expect(parsed.embedding_model).toBe("nomic-embed-text");
    expect(parsed.is_active).toBe(true);
    expect(parsed.source_kind).toBe("tenant_sop");
  });

  it("rejects chunks without a tenant owner", () => {
    const input = build_valid_metadata();
    delete input.tenant_id;
    expect(() => chunk_metadata_schema.parse(input)).toThrow();
  });

  it("rejects malformed effective_from dates", () => {
    expect(() =>
      chunk_metadata_schema.parse({
        ...build_valid_metadata(),
        effective_from: "01-01-2026",
      }),
    ).toThrow();
    expect(() =>
      chunk_metadata_schema.parse({
        ...build_valid_metadata(),
        effective_from: "2026-13-40",
      }),
    ).toThrow();
  });

  it("rejects unknown verticals", () => {
    expect(() =>
      chunk_metadata_schema.parse({
        ...build_valid_metadata(),
        vertical: "restaurant",
      }),
    ).toThrow();
  });
});
