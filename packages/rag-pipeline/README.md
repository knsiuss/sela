# @repo/rag-pipeline

Canonical RAG package for tenant-scoped clinic knowledge (policies, FAQs, and
operating procedures).

## Modules

- `src/chunker.ts` — bounded policy-aware chunking and PII rejection.
- `src/retriever.ts` — tenant-filtered vector retrieval, precedence, and audit.
- `src/hybrid_search.ts` — tenant-filtered FTS/vector retrieval and RRF.
- `src/embedding_providers.ts` — versioned fake and OpenAI providers.
- `src/eval_golden_set.ts` — recall@k against labeled questions.
- `src/scrub.ts` — fail-closed pre-embedding PII and secret handling.

The database contract is defined by `packages/db/migrations/0003_rag.sql`.
Local infrastructure and embedding operations are documented in
`pgvector_infra.md`.
