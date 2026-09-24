-- 0004_webhook_jobs: durable ingress claims and the worker-facing webhook queue.
-- Apply after 0001_init.sql through 0003_rag.sql.

-- A claim is deliberately separate from webhook_jobs: enqueue can fail after
-- the ingress claim, and the claim must be released so Meta retries are not lost.
CREATE TABLE processed_messages (
    wamid      TEXT PRIMARY KEY CHECK (char_length(wamid) BETWEEN 1 AND 128),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE webhook_jobs (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    request_id      TEXT NOT NULL CHECK (char_length(request_id) BETWEEN 1 AND 128),
    wamid           TEXT NOT NULL UNIQUE CHECK (char_length(wamid) BETWEEN 1 AND 128),
    conversation_id TEXT NOT NULL CHECK (char_length(conversation_id) BETWEEN 1 AND 128),
    received_at_iso TIMESTAMPTZ NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'claimed', 'completed', 'failed')),
    attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    claimed_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Worker claims are oldest-first and use FOR UPDATE SKIP LOCKED; this partial
-- index keeps completed and failed rows out of the hot claim scan.
CREATE INDEX webhook_jobs_claim_idx
    ON webhook_jobs (status, created_at, id)
    WHERE status = 'pending';
