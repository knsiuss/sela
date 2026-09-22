import type { ScoredChunk } from "./types.js";

const RRF_K = 60;

/**
 * Reciprocal Rank Fusion over ranked lists.
 *
 * score(doc) = sum(1 / (k + rank)) per list. Merges vector + keyword
 * results without normalizing incompatible score scales.
 *
 * Args:
 *   lists: Ranked chunk lists, best first. Content carried from first sighting.
 *
 * Returns:
 *   Merged list sorted by fused score, best first.
 */
export function reciprocal_rank_fusion(lists: ScoredChunk[][]): ScoredChunk[] {
  const fused = new Map<string, { chunk: ScoredChunk; score: number }>();
  for (const list of lists) {
    list.forEach((chunk, index) => {
      const entry = fused.get(chunk.chunk_id) ?? { chunk, score: 0 };
      entry.score += 1 / (RRF_K + index + 1);
      fused.set(chunk.chunk_id, entry);
    });
  }
  return [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .map((entry) => ({ ...entry.chunk, score: entry.score }));
}

export interface HybridQuery {
  tenant_id: string;
  text: string;
  vector_literal: string;
  limit_each: number;
  limit_final: number;
}

/**
 * Build the hybrid retrieval query: tenant-scoped vector cosine plus
 * Postgres full-text rank, fused with RRF in SQL.
 *
 * Tenant filter applies to BOTH arms; no unfiltered search path exists.
 */
export function build_hybrid_query(query: HybridQuery): { sql: string; params: unknown[] } {
  const sql = `
    WITH vector_hits AS (
      SELECT chunk_id, content,
             ROW_NUMBER() OVER (ORDER BY embedding <=> $2::vector) AS rank
      FROM knowledge_chunks
      WHERE tenant_id = $1 AND is_active = true
      ORDER BY embedding <=> $2::vector
      LIMIT $3
    ),
    keyword_hits AS (
      SELECT chunk_id, content,
             ROW_NUMBER() OVER (ORDER BY ts_rank_cd(search_vector, plainto_tsquery('simple', $4)) DESC) AS rank
      FROM knowledge_chunks
      WHERE tenant_id = $1 AND is_active = true
        AND search_vector @@ plainto_tsquery('simple', $4)
      LIMIT $3
    ),
    fused AS (
      SELECT chunk_id, content, SUM(1.0 / (60 + rank)) AS fused_score
      FROM (
        SELECT chunk_id, content, rank FROM vector_hits
        UNION ALL
        SELECT chunk_id, content, rank FROM keyword_hits
      ) combined
      GROUP BY chunk_id, content
    )
    SELECT chunk_id, content, fused_score AS score
    FROM fused
    ORDER BY fused_score DESC
    LIMIT $5;
  `;
  return {
    sql,
    params: [query.tenant_id, query.vector_literal, query.limit_each, query.text, query.limit_final],
  };
}
