/** Unit tests for tenant-scoped retrieval, precedence, and audit safety. */
import { describe, expect, it } from "vitest";
import {
  MissingTenantFilterError,
  RETRIEVE_TOP_K,
  build_retrieval_audit_entry,
  build_retrieval_query,
  build_tenant_filter,
  decide_retrieval_outcome,
  hash_query_text,
  rerank_and_filter,
  sort_by_policy_precedence,
} from "../src/retriever.js";
import type { CandidateChunk, SopChunk } from "../src/rag_types.js";

function build_test_chunk(overrides: Partial<SopChunk> = {}): SopChunk {
  return {
    chunk_id: "sop_reschedule_v3:chunk_0000",
    content: "Late cancels need 4h notice.",
    metadata: {
      doc_id: "sop_reschedule_v3",
      effective_from: "2026-01-01",
      embedding_model: "nomic-embed-text",
      embedding_version: "v1",
      is_active: true,
      locale: "en",
      section: "late_cancel_policy",
      source_kind: "tenant_sop",
      source_uri: "dashboard://clinic_a/sop_reschedule_v3",
      tenant_id: "clinic_a",
      vertical: "dental",
    },
    token_count: 320,
    ...overrides,
  };
}

describe("build_tenant_filter", () => {
  it("always pins tenant_id and active rows first", () => {
    const filter = build_tenant_filter("clinic_a");
    expect(filter.where_clause).toBe("tenant_id = $1 AND is_active = $2");
    expect(filter.params).toEqual(["clinic_a", true]);
  });

  it("appends optional scope without changing parameter order", () => {
    const filter = build_tenant_filter("clinic_a", {
      locale: "en",
      vertical: "dental",
    });
    expect(filter.where_clause.includes("vertical = $3")).toBe(true);
    expect(filter.where_clause.includes("locale = $4")).toBe(true);
    expect(filter.params).toEqual(["clinic_a", true, "dental", "en"]);
  });

  it("fails closed on an empty tenant_id", () => {
    expect(() => build_tenant_filter("   ")).toThrow(MissingTenantFilterError);
  });
});

describe("build_retrieval_query", () => {
  it("orders by cosine distance and caps at the retrieve limit", () => {
    const query = build_retrieval_query({ tenant_id: "clinic_a" });
    expect(query.text.includes("embedding <=> $1::vector")).toBe(true);
    expect(query.text.includes(`LIMIT ${RETRIEVE_TOP_K}`)).toBe(true);
    expect(query.text.includes("tenant_id = $2")).toBe(true);
    expect(query.text.includes("clinic_a")).toBe(false);
  });
});

describe("sort_by_policy_precedence", () => {
  it("ranks tenant SOP above vertical default", () => {
    const tenant_chunk = build_test_chunk();
    const default_chunk = build_test_chunk({
      chunk_id: "vertical_dental:chunk_0000",
      metadata: { ...tenant_chunk.metadata, source_kind: "vertical_default" },
    });
    const ordered = sort_by_policy_precedence([
      { chunk: default_chunk, similarity: 0.95 },
      { chunk: tenant_chunk, similarity: 0.5 },
    ]);
    expect(ordered[0]?.chunk.chunk_id).toBe(tenant_chunk.chunk_id);
  });

  it("prefers newer effective_from within one rank", () => {
    const old_chunk = build_test_chunk();
    const new_chunk = build_test_chunk({
      chunk_id: "sop_reschedule_v4:chunk_0000",
      metadata: { ...old_chunk.metadata, effective_from: "2026-06-01" },
    });
    const ordered: CandidateChunk[] = sort_by_policy_precedence([
      { chunk: old_chunk, similarity: 0.9 },
      { chunk: new_chunk, similarity: 0.8 },
    ]);
    expect(ordered[0]?.chunk.chunk_id).toBe(new_chunk.chunk_id);
  });
});

describe("rerank_and_filter", () => {
  it("keeps the top five at or above threshold", () => {
    const candidates: CandidateChunk[] = Array.from({ length: 8 }, (_, i) => ({
      chunk: build_test_chunk({ chunk_id: `chunk_${i}` }),
      similarity: 0.9 - i * 0.05,
    }));
    const kept = rerank_and_filter(candidates, 0.5);
    expect(kept.length).toBe(5);
    expect(kept.every((candidate) => candidate.similarity >= 0.5)).toBe(true);
  });
});

describe("decide_retrieval_outcome", () => {
  it("returns clarify with no chunks on weak matches", () => {
    const outcome = decide_retrieval_outcome([
      { chunk: build_test_chunk(), similarity: 0.1 },
    ]);
    expect(outcome.decision).toBe("clarify");
    expect(outcome.chunks).toEqual([]);
    expect(outcome.citations).toEqual([]);
  });

  it("returns answer with citations on strong matches", () => {
    const outcome = decide_retrieval_outcome([
      { chunk: build_test_chunk(), similarity: 0.9 },
    ]);
    expect(outcome.decision).toBe("answer");
    expect(outcome.citations[0]?.doc_id).toBe("sop_reschedule_v3");
    expect(outcome.citations[0]?.section).toBe("late_cancel_policy");
  });
});

describe("retrieval audit safety", () => {
  it("hashes queries deterministically without exposing text", () => {
    const first = hash_query_text("when can I reschedule?");
    expect(first).toBe(hash_query_text("when can I reschedule?"));
    expect(first.includes("reschedule")).toBe(false);
  });

  it("excludes chunk text and raw queries from the audit entry", () => {
    const outcome = decide_retrieval_outcome([
      { chunk: build_test_chunk(), similarity: 0.9 },
    ]);
    const entry = build_retrieval_audit_entry({
      embedding_model: "nomic-embed-text",
      embedding_version: "v1",
      outcome,
      request_id: "req_123",
      scope: {},
      tenant_id: "clinic_a",
    });
    expect(JSON.stringify(entry).includes("Late cancels need")).toBe(false);
    expect(entry.chunk_ids).toEqual(["sop_reschedule_v3:chunk_0000"]);
  });
});
