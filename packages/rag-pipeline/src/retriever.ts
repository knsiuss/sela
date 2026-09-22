/** Tenant-scoped retrieval: mandatory filter, rerank, precedence, audit.
 *
 * Implements doc 08 section 7: filter first on tenant_id, retrieve top 20 by
 * vector similarity, rerank to top 5, drop weak matches (clarify instead),
 * and sort tenant SOPs above vertical defaults. There is no unfiltered
 * search path in this module; a missing tenant fails closed.
 */
import { createHash } from "node:crypto";
import {
  type CandidateChunk,
  type ChunkCitation,
  type RetrievalAuditEntry,
  type RetrievalOutcome,
  type RetrievalScope,
  type SopChunk,
} from "./rag_types.js";

/** Candidates fetched by vector similarity before reranking. */
export const RETRIEVE_TOP_K = 20;

/** Chunks passed to the prompt after reranking. */
export const RERANK_TOP_K = 5;

/**
 * Minimum cosine similarity kept after reranking. Starting point only: the
 * design doc requires a calibrated threshold, so tune this against the
 * golden question set per vertical before relying on it in production.
 */
export const DEFAULT_RELEVANCE_THRESHOLD = 0.35;

/** Raised when a query arrives without a tenant scope. */
export class MissingTenantFilterError extends Error {
  constructor() {
    super("retrieval requires a non-empty tenant_id filter");
    this.name = "MissingTenantFilterError";
  }
}

/** Parameterized tenant filter fragment for Postgres/pgvector queries. */
export interface TenantFilter {
  params: Array<string | boolean>;
  where_clause: string;
}

/**
 * Build the mandatory tenant filter fragment.
 *
 * tenant_id is always the first parameter and is_active always true, so
 * superseded chunks never leak into answers. Optional scope narrows by
 * vertical and locale. The fragment composes into larger WHERE clauses.
 *
 * @param tenant_id Owning tenant. Empty values fail closed.
 * @param scope Optional vertical and locale narrowing.
 * @param start_index First $n placeholder index, for composing queries.
 * @returns SQL fragment with ordered parameter values.
 * @throws MissingTenantFilterError when tenant_id is empty.
 */
export function build_tenant_filter(
  tenant_id: string,
  scope: RetrievalScope = {},
  start_index = 1,
): TenantFilter {
  if (tenant_id.trim() === "") {
    throw new MissingTenantFilterError();
  }
  let placeholder_index = start_index;
  const conditions: string[] = [];
  const params: Array<string | boolean> = [];

  conditions.push(`tenant_id = $${placeholder_index}`);
  params.push(tenant_id);
  placeholder_index += 1;

  conditions.push(`is_active = $${placeholder_index}`);
  params.push(true);
  placeholder_index += 1;

  if (scope.vertical !== undefined) {
    conditions.push(`vertical = $${placeholder_index}`);
    params.push(scope.vertical);
    placeholder_index += 1;
  }
  if (scope.locale !== undefined) {
    conditions.push(`locale = $${placeholder_index}`);
    params.push(scope.locale);
    placeholder_index += 1;
  }
  return { params, where_clause: conditions.join(" AND ") };
}

/** Arguments for building the pgvector similarity query. */
export interface RetrievalQueryInput {
  candidate_limit?: number;
  embedding_placeholder?: string;
  scope?: RetrievalScope;
  tenant_id: string;
}

/** Parameterized SQL plus ordered values, ready for any pg driver. */
export interface RetrievalQuery {
  text: string;
  values: Array<string | boolean | number>;
}

/**
 * Build the tenant-scoped pgvector nearest-neighbor query.
 *
 * Orders by cosine distance ascending and caps at RETRIEVE_TOP_K. The query
 * embedding itself is driver-specific (vector serialization differs), so the
 * caller supplies its placeholder expression and this builder only appends
 * the filter values in order.
 *
 * @param query_input Tenant, scope, and embedding placeholder.
 * @returns Parameterized SQL text with ordered values.
 * @throws MissingTenantFilterError when tenant_id is empty.
 */
export function build_retrieval_query(
  query_input: RetrievalQueryInput,
): RetrievalQuery {
  const candidate_limit = query_input.candidate_limit ?? RETRIEVE_TOP_K;
  const embedding_placeholder = query_input.embedding_placeholder ?? "$1";
  const filter = build_tenant_filter(
    query_input.tenant_id,
    query_input.scope ?? {},
    2,
  );
  const text = [
    "SELECT chunk_id, content, metadata, embedding <=> " +
      `${embedding_placeholder}::vector AS distance`,
    "FROM rag_chunks",
    `WHERE ${filter.where_clause}`,
    "ORDER BY distance ASC",
    `LIMIT ${Math.trunc(candidate_limit)}`,
  ].join("\n");
  return { text, values: filter.params };
}

/**
 * Sort candidates by policy precedence, preserving relevance within ranks.
 *
 * Tenant SOPs outrank vertical defaults; within one rank, newer
 * effective_from wins; ties break by higher similarity. This enforces the
 * rule that a tenant override always beats the shared starter pack.
 *
 * @param candidates Reranked candidates with similarity scores.
 * @returns New array ordered by precedence (input is not mutated).
 */
export function sort_by_policy_precedence(
  candidates: CandidateChunk[],
): CandidateChunk[] {
  return [...candidates].sort((left, right) => {
    const left_is_override =
      left.chunk.metadata.source_kind === "tenant_sop" ? 0 : 1;
    const right_is_override =
      right.chunk.metadata.source_kind === "tenant_sop" ? 0 : 1;
    if (left_is_override !== right_is_override) {
      return left_is_override - right_is_override;
    }
    if (left.chunk.metadata.effective_from !== right.chunk.metadata.effective_from) {
      return right.chunk.metadata.effective_from.localeCompare(
        left.chunk.metadata.effective_from,
      );
    }
    return right.similarity - left.similarity;
  });
}

/**
 * Rerank candidates by score and drop weak matches.
 *
 * Keeps at most RERANK_TOP_K candidates at or above the threshold. An empty
 * result is not an error: the caller should ask a clarifying question rather
 * than answer from a weak match.
 *
 * @param candidates Raw vector candidates with similarity scores.
 * @param relevance_threshold Minimum similarity kept; defaults to calibrated start.
 * @returns Top candidates ordered by descending similarity.
 */
export function rerank_and_filter(
  candidates: CandidateChunk[],
  relevance_threshold: number = DEFAULT_RELEVANCE_THRESHOLD,
): CandidateChunk[] {
  return candidates
    .filter((candidate) => candidate.similarity >= relevance_threshold)
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, RERANK_TOP_K);
}

/**
 * Build citations for the prompt and turn log.
 *
 * @param chunks Final chunks backing the answer.
 * @returns Citations carrying doc_id and section per chunk.
 */
export function build_citations(chunks: SopChunk[]): ChunkCitation[] {
  return chunks.map((chunk) => ({
    chunk_id: chunk.chunk_id,
    doc_id: chunk.metadata.doc_id,
    section: chunk.metadata.section,
  }));
}

/**
 * Run the full post-retrieval pipeline: rerank, threshold, precedence.
 *
 * Weak or empty matches yield decision "clarify" with no chunks, so the
 * agent asks a follow-up instead of hallucinating from a poor match.
 *
 * @param candidates Raw vector candidates (up to RETRIEVE_TOP_K).
 * @param relevance_threshold Minimum similarity kept.
 * @returns Outcome with decision, chunks, citations, and scores.
 */
export function decide_retrieval_outcome(
  candidates: CandidateChunk[],
  relevance_threshold: number = DEFAULT_RELEVANCE_THRESHOLD,
): RetrievalOutcome {
  const reranked = rerank_and_filter(candidates, relevance_threshold);
  if (reranked.length === 0) {
    return { citations: [], chunks: [], decision: "clarify", scores: [] };
  }
  const ordered = sort_by_policy_precedence(reranked);
  const chunks = ordered.map((candidate) => candidate.chunk);
  return {
    citations: build_citations(chunks),
    chunks,
    decision: "answer",
    scores: ordered.map((candidate) => candidate.similarity),
  };
}

/**
 * Hash a user query for audit logging without storing its text.
 *
 * @param raw_query Raw user message. Never persisted or logged directly.
 * @returns Truncated SHA-256 hex digest safe for logs.
 */
export function hash_query_text(raw_query: string): string {
  return createHash("sha256").update(raw_query, "utf8").digest("hex").slice(0, 16);
}

/** Context needed to record one RAG turn for audit. */
export interface AuditContext {
  embedding_model: string;
  embedding_version: string;
  outcome: RetrievalOutcome;
  request_id: string;
  scope: RetrievalScope;
  tenant_id: string;
}

/**
 * Build an audit entry holding identifiers and scores only.
 *
 * Chunk text and the raw query are deliberately excluded so audit logs stay
 * free of PII by construction.
 *
 * @param audit_context Outcome, tenant, request, and model version.
 * @returns Log-safe audit entry.
 */
export function build_retrieval_audit_entry(
  audit_context: AuditContext,
): RetrievalAuditEntry {
  return {
    chunk_ids: audit_context.outcome.chunks.map((chunk) => chunk.chunk_id),
    doc_ids: [
      ...new Set(
        audit_context.outcome.chunks.map((chunk) => chunk.metadata.doc_id),
      ),
    ],
    embedding_model: audit_context.embedding_model,
    embedding_version: audit_context.embedding_version,
    rerank_scores: audit_context.outcome.scores,
    request_id: audit_context.request_id,
    scope: audit_context.scope,
    tenant_id: audit_context.tenant_id,
  };
}
