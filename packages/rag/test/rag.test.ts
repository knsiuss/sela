import { describe, expect, it } from "vitest";
import { chunk_markdown } from "../src/chunk.js";
import { FakeEmbedding } from "../src/embeddings.js";
import { reciprocal_rank_fusion, build_hybrid_query } from "../src/retrieve.js";
import { evaluate_golden_set } from "../src/evaluate.js";

const base = {
  tenant_id: "t1",
  vertical: "dental",
  doc_id: "sop_cancel",
  locale: "id",
  effective_from: "2026-01-01",
  source_uri: "dashboard://t1/sop_cancel",
};

describe("chunk_markdown", () => {
  it("test_chunk_markdown_keeps_short_sections_whole", () => {
    const chunks = chunk_markdown("## Kebijakan\nBatal H-1 gratis.", base);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunk_id).toBe("sop_cancel#0");
  });

  it("test_chunk_markdown_splits_oversized_sections_with_overlap", () => {
    const big = `## Panjang\n${"kalimat penting tentang kebijakan pembatalan. ".repeat(120)}`;
    const chunks = chunk_markdown(big, base);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].content.length).toBeGreaterThan(0);
  });
});

describe("embeddings", () => {
  it("test_fake_embedding_returns_normalized_vectors", async () => {
    const provider = new FakeEmbedding(32);
    const [vector] = await provider.embed(["halo"]);
    expect(vector).toHaveLength(32);
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    expect(norm).toBeCloseTo(1);
  });
});

describe("retrieve", () => {
  it("test_reciprocal_rank_fusion_prefers_multi_list_hits", () => {
    const a = { chunk_id: "d#0", content: "a", score: 0 };
    const b = { chunk_id: "d#1", content: "b", score: 0 };
    const merged = reciprocal_rank_fusion([[a], [b, a]]);
    expect(merged[0].chunk_id).toBe("d#0");
  });

  it("test_build_hybrid_query_scopes_both_arms_by_tenant", () => {
    const { sql, params } = build_hybrid_query({
      tenant_id: "t1",
      text: "batal",
      vector_literal: "[0.1,0.2]",
      limit_each: 20,
      limit_final: 5,
    });
    expect(params[0]).toBe("t1");
    expect(sql).toContain("tenant_id = $1");
    expect(sql.split("tenant_id = $1")).toHaveLength(3);
  });
});

describe("evaluate", () => {
  it("test_evaluate_golden_set_counts_recall", async () => {
    const report = await evaluate_golden_set(
      [{ question: "q", expected_doc_ids: ["sop_cancel"], expected_action: "answer" }],
      async () => ["sop_cancel#0"],
    );
    expect(report.recall_at_k).toBe(1);
    expect(report.misses).toHaveLength(0);
  });
});
