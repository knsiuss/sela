-- 0009_worker_leases: bounded worker leases and fencing tokens for webhook jobs.
-- The token is nullable so rows created before this migration remain valid.
-- A claimed row is recoverable from claimed_at; the application treats a row
-- older than five minutes (or a NULL claimed_at) as stale and assigns a fresh
-- token when it is reclaimed.

ALTER TABLE public.webhook_jobs
    ADD COLUMN IF NOT EXISTS claim_token TEXT;

COMMENT ON COLUMN public.webhook_jobs.claim_token IS
    'Opaque token identifying the current worker claim; NULL for legacy rows.';

-- Pending work uses the existing claim indexes. This partial index keeps stale
-- claimed rows cheap to recover without adding completed or failed rows to the
-- lease scan.
CREATE INDEX IF NOT EXISTS webhook_jobs_stale_claim_idx
    ON public.webhook_jobs (claimed_at, created_at, id)
    WHERE status = 'claimed';
