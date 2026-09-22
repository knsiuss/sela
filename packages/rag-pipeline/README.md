# @repo/rag-pipeline

Retrieval helpers for clinic knowledge (policies, FAQs, schedules) shared
by appointment apps.

## Status

Active. Implements tenant-scoped chunking (`src/chunker.ts`), retrieval
with relevance threshold and audit (`src/retriever.ts`), and zod schemas
for chunk metadata (`src/rag_types.ts`).

## Layout

- `src/index.ts` — placeholder passage type and retriever signature.
- `tsconfig.json` — extends the root `tsconfig.base.json`.
