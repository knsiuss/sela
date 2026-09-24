/** Enterprise multi-tenant RAG pipeline for tenant SOP and policy knowledge. */
export {
  CHARS_PER_TOKEN,
  MAX_CHUNK_TOKENS,
  MIN_CHUNK_TOKENS,
  OVERLAP_TARGET_RATIO,
  build_chunk_id,
  estimate_token_count,
  pack_units_into_chunks,
  split_document_into_chunks,
  split_into_atomic_units,
  split_oversized_unit,
} from "./chunker.js";
export type { ChunkDocumentInput } from "./chunker.js";
export {
  EmbeddingProviderError,
  FakeEmbedding,
  OpenAIEmbedding,
} from "./embedding_providers.js";
export type {
  EmbeddingProvider,
  EmbeddingProviderErrorCode,
} from "./embedding_providers.js";
export {
  GoldenSetEvaluationError,
  evaluate_golden_set,
} from "./eval_golden_set.js";
export type {
  EvalReport,
  GoldenSetItem,
  GoldenSetRetriever,
} from "./eval_golden_set.js";
export {
  InvalidHybridQueryError,
  RRF_RANK_CONSTANT,
  build_hybrid_query,
  reciprocal_rank_fusion,
} from "./hybrid_search.js";
export type {
  HybridQuery,
  HybridQueryInput,
  ScoredChunk,
} from "./hybrid_search.js";
export {
  DEFAULT_RELEVANCE_THRESHOLD,
  InvalidRetrievalQueryError,
  MissingTenantFilterError,
  RERANK_TOP_K,
  RETRIEVE_TOP_K,
  build_citations,
  build_retrieval_audit_entry,
  build_retrieval_query,
  build_tenant_filter,
  decide_retrieval_outcome,
  hash_query_text,
  rerank_and_filter,
  sort_by_policy_precedence,
} from "./retriever.js";
export type {
  AuditContext,
  RetrievalQuery,
  RetrievalQueryInput,
  TenantFilter,
} from "./retriever.js";
export {
  DEFAULT_EMBEDDING_DIMENSIONS,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_EMBEDDING_PROVIDER,
  DEFAULT_EMBEDDING_VERSION,
  chunk_metadata_schema,
  retrieval_scope_schema,
  sop_chunk_schema,
  source_kind_schema,
  vertical_schema,
} from "./rag_types.js";
export type {
  CandidateChunk,
  ChunkCitation,
  ChunkMetadata,
  RetrievalAuditEntry,
  RetrievalDecision,
  RetrievalOutcome,
  RetrievalScope,
  SopChunk,
} from "./rag_types.js";
export {
  MAX_SECRET_FRACTION,
  REDACTED_EMAIL,
  REDACTED_PHONE,
  REDACTED_SECRET,
  UnsafeChunkError,
  assert_chunk_is_safe,
  scrub_pii_from_text,
} from "./scrub.js";
