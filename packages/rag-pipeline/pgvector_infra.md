# pgvector Infrastructure Note — RAG Pipeline

> Scope: local and hosted Postgres with `pgvector` backing `packages/rag-pipeline`.
> Evidence: phidata cookbook (fully local RAG with Ollama + PgVector via a docker
> helper script) and the n8n local RAG pattern (Ollama + Postgres pgvector).
> Decision: start with `pgvector` per doc 08 section 9 — one database, one
> backup — and extract to Qdrant only when measured p95 latency justifies it.

## 1. Docker (local development)

Run a vector-ready Postgres with the same helper-script pattern the phidata
cookbook proves out:

```yaml
# infra/docker/docker-compose.pgvector.yml (proposed, not yet added)
services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: sela
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: sela
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
```

Start it with:

```bash
docker compose -f infra/docker/docker-compose.pgvector.yml up -d
```

Never commit real passwords; `${POSTGRES_PASSWORD}` resolves from the
environment only.

## 2. Extension and inventory table

Postgres is the inventory (source of truth); pgvector is the index. Every
vector row has a matching Postgres row keyed by `chunk_id`:

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE rag_chunks (
    chunk_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    vertical TEXT NOT NULL,
    doc_id TEXT NOT NULL,
    section TEXT NOT NULL,
    locale TEXT NOT NULL DEFAULT 'en',
    effective_from DATE NOT NULL,
    source_uri TEXT NOT NULL,
    source_kind TEXT NOT NULL DEFAULT 'tenant_sop'
        CHECK (source_kind IN ('tenant_sop', 'vertical_default')),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    embedding_model TEXT NOT NULL DEFAULT 'nomic-embed-text',
    embedding_version TEXT NOT NULL DEFAULT 'v1',
    content TEXT NOT NULL,
    embedding vector(768) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX rag_chunks_tenant_active_idx
    ON rag_chunks (tenant_id, vertical, locale)
    WHERE (is_active = TRUE);
```

Dimension note: `vector(768)` matches Ollama `nomic-embed-text`. If the
deployment switches models, resize the column and re-embed every chunk as a
tracked migration — mixing dimensions in one column corrupts search.

## 3. Similarity index

Pick one, per data volume:

```sql
-- Up to ~1M chunks: exact search is fine, no index needed.
-- Beyond that, HNSW gives the best recall/latency trade-off:
CREATE INDEX rag_chunks_embedding_hnsw_idx
    ON rag_chunks USING hnsw (embedding vector_cosine_ops);
```

Tenant deletion stays scoped and verified by count, in both stores:

```sql
DELETE FROM rag_chunks WHERE tenant_id = $1;
-- Then delete the same tenant_id in the vector collection and compare counts.
```

## 4. Embedding service (Ollama)

Default per this package: Ollama serving `nomic-embed-text`, fully local so
no PHI or SOP text leaves the deployment for embedding. Record
`embedding_model` and `embedding_version` on every chunk; the retriever
echoes both into the audit entry so a model change is always traceable.
