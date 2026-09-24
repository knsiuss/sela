/** Hybrid retrieval with tenant-scoped FTS and vector arms fused by RRF. */
import { MissingTenantFilterError } from "./retriever.js";

/** Rank offset used by reciprocal rank fusion. */
export const RRF_RANK_CONSTANT = 60;

/** Minimal ranked candidate consumed by reciprocal rank fusion. */
export interface ScoredChunk {
  chunk_id: string;
  content: string;
  score: number;
}

/** Input for the tenant-scoped hybrid SQL builder. */
export interface HybridQueryInput {
  embedding_value: string | number[];
  limit_each: number;
  limit_final: number;
  tenant_id: string;
  text: string;
}

/** Parameterized hybrid query and values ready for a pg driver. */
export interface HybridQuery {
  sql: string;
  params: Array<string | number>;
}

/** Raised when hybrid retrieval receives structurally invalid input. */
export class InvalidHybridQueryError extends Error {
  constructor(message: string) {
    super(`invalid hybrid query: ${message}`);
    this.name = "InvalidHybridQueryError";
  }
}

/**
 * Fuse ranked candidate lists with reciprocal rank fusion.
 *
 * Each appearance contributes `1 / (RRF_RANK_CONSTANT + rank)`, so scale and
 * calibration differences between FTS and vector scores do not dominate the
 * merged order. The first occurrence supplies the caller's chunk content.
 *
 * @param ranked_lists Candidate lists ordered best first.
 * @returns A new list ordered by descending fused score.
 */
export function reciprocal_rank_fusion(
  ranked_lists: ReadonlyArray<ReadonlyArray<ScoredChunk>>,
): ScoredChunk[] {
  const fused = new Map<string, { chunk: ScoredChunk; score: number }>();
  for (const ranked_list of ranked_lists) {
    ranked_list.forEach((chunk, index) => {
      const entry = fused.get(chunk.chunk_id) ?? { chunk, score: 0 };
      entry.score += 1 / (RRF_RANK_CONSTANT + index + 1);
      fused.set(chunk.chunk_id, entry);
    });
  }
  return [...fused.values()]
    .sort((left, right) => right.score - left.score)
    .map((entry) => ({ ...entry.chunk, score: entry.score }));
}

function serialize_embedding_value(embedding_value: string | number[]): string {
  if (typeof embedding_value === "string") {
    if (embedding_value.trim() === "") {
      throw new InvalidHybridQueryError("embedding_value must not be empty");
    }
    return embedding_value;
  }
  if (!embedding_value.every(Number.isFinite)) {
    throw new InvalidHybridQueryError("embedding_value must contain finite numbers");
  }
  return JSON.stringify(embedding_value);
}

function validate_limit(limit: number, field_name: string): void {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new InvalidHybridQueryError(`${field_name} must be a positive integer`);
  }
}

/**
 * Build a parameterized hybrid query against `knowledge_chunks`.
 *
 * The same tenant predicate is required in both the FTS and vector CTEs.
 * SQL is assembled only from fixed fragments; text, tenant, vector, and limits
 * remain bound parameters.
 *
 * @param query_input Tenant scope, query text, embedding, and result limits.
 * @returns Hybrid SQL and values in placeholder order.
 * @throws MissingTenantFilterError when tenant_id is empty.
 * @throws InvalidHybridQueryError when text, limits, or vector are invalid.
 */
export function build_hybrid_query(query_input: HybridQueryInput): HybridQuery {
  if (query_input.tenant_id.trim() === "") {
    throw new MissingTenantFilterError();
  }
  if (query_input.text.trim() === "") {
    throw new InvalidHybridQueryError("text must not be empty");
  }
  validate_limit(query_input.limit_each, "limit_each");
  validate_limit(query_input.limit_final, "limit_final");
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
             ROW_NUMBER() OVER (
               ORDER BY ts_rank_cd(
                 search_vector,
                 plainto_tsquery('simple', $4)
               ) DESC
             ) AS rank
      FROM knowledge_chunks
      WHERE tenant_id = $1 AND is_active = true
        AND search_vector @@ plainto_tsquery('simple', $4)
      LIMIT $3
    ),
    fused AS (
      SELECT chunk_id, content,
             SUM(1.0 / (${RRF_RANK_CONSTANT} + rank)) AS fused_score
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
    params: [
      query_input.tenant_id,
      serialize_embedding_value(query_input.embedding_value),
      query_input.limit_each,
      query_input.text,
      query_input.limit_final,
    ],
  };
}
