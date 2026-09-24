/** Unit tests for tenant-scoped hybrid retrieval and reciprocal rank fusion. */
import { describe, expect, it } from "vitest";
import {
  InvalidHybridQueryError,
  build_hybrid_query,
  reciprocal_rank_fusion,
} from "../src/hybrid_search.js";
import { MissingTenantFilterError } from "../src/retriever.js";
import type { ScoredChunk } from "../src/hybrid_search.js";

describe("reciprocal_rank_fusion", () => {
  it("prefers chunks that rank well across both retrieval arms", () => {
    const first_hit: ScoredChunk = {
      chunk_id: "sop_reschedule:chunk_0000",
      content: "Reschedule policy",
      score: 0.9,
    };
    const second_hit: ScoredChunk = {
      chunk_id: "sop_reschedule:chunk_0001",
      content: "Cancellation policy",
      score: 0.8,
    };

    const fused = reciprocal_rank_fusion([
      [first_hit],
      [second_hit, first_hit],
    ]);

    expect(fused[0]?.chunk_id).toBe(first_hit.chunk_id);
    expect(fused[0]?.score).toBeGreaterThan(fused[1]?.score ?? 0);
  });
});

describe("build_hybrid_query", () => {
  it("applies the mandatory tenant filter to both retrieval arms", () => {
    const query = build_hybrid_query({
      tenant_id: "clinic_a",
      text: "late cancellation",
      embedding_value: [0.1, 0.2],
      limit_each: 20,
      limit_final: 5,
    });

    expect(query.params[0]).toBe("clinic_a");
    expect(query.sql.match(/tenant_id = \$1/g)).toHaveLength(2);
    expect(query.sql).toContain("knowledge_chunks");
  });

  it("fails closed when the tenant is empty", () => {
    expect(() =>
      build_hybrid_query({
        tenant_id: " ",
        text: "late cancellation",
        embedding_value: "[0.1,0.2]",
        limit_each: 20,
        limit_final: 5,
      }),
    ).toThrow(MissingTenantFilterError);
  });

  it.each([
    { text: " ", embedding_value: "[0.1]", limit_each: 20, limit_final: 5 },
    { text: "policy", embedding_value: [Number.NaN], limit_each: 20, limit_final: 5 },
    { text: "policy", embedding_value: "[0.1]", limit_each: 0, limit_final: 5 },
    { text: "policy", embedding_value: "[0.1]", limit_each: 20, limit_final: 1.5 },
  ])("rejects invalid query input", (input) => {
    expect(() =>
      build_hybrid_query({ tenant_id: "clinic_a", ...input }),
    ).toThrow(InvalidHybridQueryError);
  });
});
