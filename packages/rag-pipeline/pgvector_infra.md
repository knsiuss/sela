# pgvector Infrastructure Note — RAG Pipeline

> Canonical schema: `packages/db/migrations/0003_rag.sql`.
> Package: `@repo/rag-pipeline`.
> Deployment baseline: PostgreSQL with `pgvector` and 1536-dimensional OpenAI
> `text-embedding-3-small` embeddings.

## 1. Local PostgreSQL

Use a vector-ready PostgreSQL image for local development. Keep credentials in
the environment or the local secret store; never place them in this file.

```yaml
# infra/docker/docker-compose.pgvector.yml (proposed, not yet added)
services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
```

Apply the repository migrations in filename order. Do not copy an independent
schema from this note into production.

## 2. Inventory and Index

`knowledge_documents` is the document inventory. `knowledge_chunks` stores
chunk content, validated JSON metadata, the generated FTS vector, and the
embedding index row. Both retrieval arms must include:

```sql
WHERE tenant_id = $1 AND is_active = true
```

The retriever stores scope fields such as `vertical` and `locale` in the
validated `metadata` JSONB object. The separate indexed `tenant_id` column
remains the isolation boundary for every FTS and vector query.

The embedding column is:

```sql
embedding VECTOR(1536)
```

This width matches `text-embedding-3-small` with its default output. Changing
the model or width requires a new full re-embed migration; never mix dimensions
or model versions in one vector column.

## 3. Indexes and Deletion

Migration `0003_rag.sql` creates:

- A partial B-tree index on active `tenant_id` values.
- A GIN index on `search_vector` for full-text retrieval.
- A partial HNSW cosine index on `embedding` for nearest-neighbor retrieval.

Tenant deletion remains scoped and verified in both document and chunk
inventory paths. Vector deletion follows through the owning document foreign
key and must be verified against the expected tenant counts.

## 4. Embedding Operations

`OpenAIEmbedding` reads `OPENAI_API_KEY` at call time so credentials can rotate
without rebuilding the provider. Requests have a finite timeout. The provider
never logs the key, authorization header, input chunk text, or response body.
Record `embedding_model` and `embedding_version` on every chunk and include
both in retrieval audit records.

Managed embedding processing of healthcare or other sensitive knowledge
requires the applicable data-processing and tenant-isolation review before
production enablement.
