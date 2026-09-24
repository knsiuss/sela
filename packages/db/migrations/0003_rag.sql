-- 0003_rag: knowledge base for RAG (SOPs, policies, FAQs).
-- pgvector required. Dimensions match the embedding model version;
-- changing models = full re-embed migration, never mixed-version rows.
-- Apply with: psql "$DATABASE_URL" -f 0003_rag.sql

CREATE EXTENSION IF NOT EXISTS "vector";

CREATE TABLE knowledge_documents (
    doc_id        TEXT PRIMARY KEY,
    tenant_id     BIGINT NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    title         TEXT NOT NULL,
    source_uri    TEXT NOT NULL,
    is_active     BOOLEAN NOT NULL DEFAULT true,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE knowledge_chunks (
    chunk_id          TEXT PRIMARY KEY,
    tenant_id         BIGINT NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    doc_id            TEXT NOT NULL REFERENCES knowledge_documents (doc_id) ON DELETE CASCADE,
    section           TEXT NOT NULL,
    content           TEXT NOT NULL,
    metadata          JSONB NOT NULL,
    search_vector     TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
    embedding         VECTOR(1536),
    embedding_model   TEXT NOT NULL,
    embedding_version TEXT NOT NULL,
    is_active         BOOLEAN NOT NULL DEFAULT true,
    effective_from    DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX knowledge_chunks_tenant_active_idx
    ON knowledge_chunks (tenant_id) WHERE (is_active = true);
CREATE INDEX knowledge_chunks_search_idx
    ON knowledge_chunks USING GIN (search_vector);
CREATE INDEX knowledge_chunks_embedding_idx
    ON knowledge_chunks USING hnsw (embedding vector_cosine_ops)
    WHERE (is_active = true);
