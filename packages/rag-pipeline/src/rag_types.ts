/** Shared RAG contract: chunk metadata schema and retrieval types.
 *
 * Single source of truth for what a SOP/policy chunk looks like. Both the
 * ingestion path (chunk, scrub, embed) and the retrieval path (filter,
 * rerank, cite) validate against these schemas so Postgres rows, pgvector
 * payloads, and agent prompts can never drift apart.
 */
import { z } from "zod";

/** Default embedding model for this deployment (Ollama, runs fully local). */
export const DEFAULT_EMBEDDING_MODEL = "nomic-embed-text";

/** Provider serving the default embedding model. */
export const DEFAULT_EMBEDDING_PROVIDER = "ollama";

/** Version tag of the embedding weights. Changing models requires full re-embed. */
export const DEFAULT_EMBEDDING_VERSION = "v1";

/** Verticals supported by the starter SOP packs. */
export const vertical_schema = z.enum([
  "clinic",
  "dental",
  "salon",
  "physio",
  "home_service",
]);

/**
 * Why the chunk exists: a tenant-specific SOP override or a copied vertical
 * default. Retrieval sorts tenant SOPs above vertical defaults (doc 08, 7.4).
 */
export const source_kind_schema = z.enum(["tenant_sop", "vertical_default"]);

/**
 * Metadata attached to every chunk, stored in Postgres (inventory, source of
 * truth) and mirrored into the pgvector payload (filterable index).
 *
 * @param tenant_id Owning tenant. Every query must filter on this.
 * @param vertical Vertical starter pack the chunk derives from.
 * @param doc_id Source document id, e.g. sop_reschedule_v3.
 * @param section Semantic section inside the document, e.g. late_cancel_policy.
 * @param locale Chunk language, BCP-47 style short code.
 * @param effective_from Date the policy takes effect (YYYY-MM-DD). Newer wins.
 * @param source_uri Where the chunk came from, for audit and re-ingestion.
 * @param source_kind Tenant override or vertical default, for precedence sort.
 * @param is_active False once superseded; superseded rows are never deleted.
 * @param embedding_model Model that produced the vector, recorded per chunk.
 * @param embedding_version Weight version; a change means a re-embed migration.
 */
export const chunk_metadata_schema = z.object({
  doc_id: z.string().min(1).max(200),
  effective_from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "effective_from must use YYYY-MM-DD")
    .refine(
      (value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)),
      "effective_from must be a real calendar date",
    ),
  embedding_model: z.string().min(1).max(100).default(DEFAULT_EMBEDDING_MODEL),
  embedding_version: z
    .string()
    .min(1)
    .max(50)
    .default(DEFAULT_EMBEDDING_VERSION),
  is_active: z.boolean().default(true),
  locale: z.string().min(2).max(10).default("en"),
  section: z.string().min(1).max(200),
  source_kind: source_kind_schema.default("tenant_sop"),
  source_uri: z.string().min(1).max(500),
  tenant_id: z.string().min(1).max(100),
  vertical: vertical_schema,
});

export type ChunkMetadata = z.infer<typeof chunk_metadata_schema>;

/** A chunk ready for embedding: scrubbed text plus validated metadata. */
export const sop_chunk_schema = z.object({
  chunk_id: z.string().min(1).max(300),
  content: z.string().min(1).max(20000),
  metadata: chunk_metadata_schema,
  token_count: z.number().int().positive(),
});

export type SopChunk = z.infer<typeof sop_chunk_schema>;

/** Optional retrieval scoping. tenant_id is always required separately. */
export const retrieval_scope_schema = z.object({
  locale: z.string().min(2).max(10).optional(),
  vertical: vertical_schema.optional(),
});

export type RetrievalScope = z.infer<typeof retrieval_scope_schema>;

/** A vector candidate with its similarity score (higher is more similar). */
export interface CandidateChunk {
  chunk: SopChunk;
  similarity: number;
}

/** Retrieval outcome: answer from chunks, or clarify when matches are weak. */
export type RetrievalDecision = "answer" | "clarify";

/** Citations passed into the prompt and stored in the turn log for audit. */
export interface ChunkCitation {
  chunk_id: string;
  doc_id: string;
  section: string;
}

/** Result of the retrieve-then-rerank pipeline for one user message. */
export interface RetrievalOutcome {
  citations: ChunkCitation[];
  chunks: SopChunk[];
  decision: RetrievalDecision;
  scores: number[];
}

/**
 * Audit entry for one RAG turn. Holds identifiers and scores only, never
 * chunk text or the raw user message, so logs stay free of PII.
 */
export interface RetrievalAuditEntry {
  chunk_ids: string[];
  doc_ids: string[];
  embedding_model: string;
  embedding_version: string;
  rerank_scores: number[];
  request_id: string;
  scope: RetrievalScope;
  tenant_id: string;
}
