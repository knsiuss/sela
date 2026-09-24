-- 0008_worker_tenant_hardening: close the worker ingress privilege and tenant gaps.
-- Apply after 0007_inbound_button_id.sql.

-- processed_messages has no tenant dimension or client policy. Keep this
-- idempotency table internal: client roles and PUBLIC receive no privileges,
-- while service_role is the only server-side DML role.
ALTER TABLE public.processed_messages ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.processed_messages FROM anon, authenticated;
REVOKE ALL ON public.processed_messages FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.processed_messages TO service_role;

-- Quarantine before installing the check: NOT VALID constraints still validate
-- updated rows, so active legacy rows must be terminalized first. The lock
-- prevents a concurrent writer from inserting a null-tenant row between the
-- quarantine and constraint installation.
DO $migration$
BEGIN
    LOCK TABLE public.webhook_jobs IN SHARE ROW EXCLUSIVE MODE;

    UPDATE public.webhook_jobs
    SET status = 'failed',
        last_error = 'legacy_missing_tenant'
    WHERE tenant_id IS NULL
      AND status IN ('pending', 'claimed');

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'webhook_jobs_tenant_id_required_ck'
          AND conrelid = 'public.webhook_jobs'::regclass
          AND contype = 'c'
    ) THEN
        ALTER TABLE public.webhook_jobs
            ADD CONSTRAINT webhook_jobs_tenant_id_required_ck
            CHECK (tenant_id IS NOT NULL) NOT VALID;
    END IF;
END;
$migration$;

COMMENT ON CONSTRAINT webhook_jobs_tenant_id_required_ck ON public.webhook_jobs IS
    'NOT VALID by design: legacy rows may retain NULL tenant_id, while new and updated rows require a tenant.';
