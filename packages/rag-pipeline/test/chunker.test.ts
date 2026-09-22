/** Unit tests for policy-aware chunking. */
import { describe, expect, it } from "vitest";
import {
  build_chunk_id,
  estimate_token_count,
  pack_units_into_chunks,
  split_document_into_chunks,
  split_into_atomic_units,
} from "../src/chunker.js";
import { UnsafeChunkError } from "../src/scrub.js";
import type { ChunkDocumentInput } from "../src/chunker.js";

function build_test_input(): ChunkDocumentInput {
  return {
    content: "",
    metadata: {
      doc_id: "sop_reschedule_v3",
      effective_from: "2026-01-01",
      locale: "en",
      section: "late_cancel_policy",
      source_kind: "tenant_sop",
      source_uri: "dashboard://clinic_a/sop_reschedule_v3",
      tenant_id: "clinic_a",
      vertical: "dental",
    },
  };
}

describe("estimate_token_count", () => {
  it("returns zero for empty text", () => {
    expect(estimate_token_count("")).toBe(0);
  });

  it("scales with text length", () => {
    expect(estimate_token_count("abcd")).toBe(1);
    expect(estimate_token_count("a".repeat(400))).toBe(100);
  });
});

describe("split_into_atomic_units", () => {
  it("keeps numbered policy rules whole", () => {
    const units = split_into_atomic_units(
      "# Late cancel policy\n\n1. No-shows incur a fee.\n2. Late cancels need 4h notice.\n",
    );
    expect(units).toContain("# Late cancel policy");
    expect(units).toContain("1. No-shows incur a fee.");
    expect(units).toContain("2. Late cancels need 4h notice.");
  });

  it("keeps table rows whole", () => {
    const units = split_into_atomic_units("| fee | amount |\n| no-show | 50 |\n");
    expect(units).toEqual(["| fee | amount |", "| no-show | 50 |"]);
  });
});

describe("build_chunk_id", () => {
  it("builds deterministic zero-padded ids", () => {
    expect(build_chunk_id("sop_x", 3)).toBe("sop_x:chunk_0003");
  });
});

describe("split_document_into_chunks", () => {
  it("returns no chunks for blank documents", () => {
    expect(split_document_into_chunks("  \n ", build_test_input())).toEqual([]);
  });

  it("scrubs PII and attaches validated metadata", () => {
    const body = `${"# Policy"}\n\n${"Patients must confirm. ".repeat(60)}\n\nCall +1-555-010-2030.\n`;
    const chunks = split_document_into_chunks(body, build_test_input());
    expect(chunks.length >= 1).toBe(true);
    for (const chunk of chunks) {
      expect(chunk.content.includes("+1-555-010-2030")).toBe(false);
      expect(chunk.metadata.tenant_id).toBe("clinic_a");
      expect(chunk.metadata.embedding_model).toBe("nomic-embed-text");
    }
  });

  it("rejects documents dominated by secrets instead of embedding them", () => {
    const credential_lines = Array.from(
      { length: 30 },
      (_, index) => `api_key: credential_${index} secret: hunter${index}`,
    ).join("\n");
    const body = `${credential_lines}\nA short policy note.\n`;
    expect(() => split_document_into_chunks(body, build_test_input())).toThrow(
      UnsafeChunkError,
    );
  });

  it("never emits a non-final chunk below the token floor", () => {
    const rule = (index: number): string =>
      `${index + 1}. ${"Late cancel notices require four hours. ".repeat(14)}`;
    const body = `# Policy\n\n${Array.from({ length: 8 }, (_, i) => rule(i)).join("\n")}\n`;
    const chunks = split_document_into_chunks(body, build_test_input());
    expect(chunks.length >= 2).toBe(true);
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.token_count >= 300).toBe(true);
    }
  });

  it("keeps chunk overlap within the mandated band", () => {
    const packed = pack_units_into_chunks([
      `${"alpha ".repeat(200)}`,
      `${"beta ".repeat(200)}`,
      `${"gamma ".repeat(200)}`,
    ]);
    expect(packed.length >= 2).toBe(true);
    const first_words = new Set(packed[0]?.content.split(/\s+/));
    const second_words = (packed[1]?.content ?? "").split(/\s+/);
    const overlap_words = second_words.filter((word) => first_words.has(word));
    const ratio = overlap_words.length / second_words.length;
    expect(ratio >= 0.05 && ratio <= 0.25).toBe(true);
  });
});
