-- 0011_tenant_scoped_dedupe: scope ingress idempotency claims to their tenant.
-- Apply after 0010_reschedule_sessions.sql.
--
-- ROLLOUT (required):
--   1. Stop writers that still use the global processed_messages.wamid key and
--      deploy the tenant-scoped dedupe/atomic-ingress writers before reopening
--      ingress. 0008's RLS/grants and 0009/0010's worker behavior remain in
--      force.
--   2. If processed_messages contains legacy claims, first add its nullable
--      tenant_id column in a controlled operator transaction (the statement
--      below is intentionally commented so this migration never fabricates a
--      tenant), reconcile every existing claim to a real tenants.id, and verify
--      that no NULL remains.  Never delete a claim to make this migration pass.
--   3. Apply this migration, then verify the composite primary/unique keys and
--      service_role grants before enabling the new writers.
--
-- ROLLBACK:
--   The reconciliation/key block is transactional even under plain psql
--   autocommit, so its failure leaves the prior schema and claims intact.  If
--   a later grant/comment statement fails under a non-transactional runner,
--   inspect the committed key state before retrying and do not reopen ingress.
--   After a successful application, do not remove either composite key while
--   tenant-scoped writers are live.  Roll back code and schema together only
--   after stopping all writers and checking that no cross-tenant duplicate
--   wamid would violate the former global key; otherwise restore from the
--   pre-migration backup.  Do not delete claims during rollback.
--
-- Operator pre-stage, when needed (run separately before this migration):
-- ALTER TABLE public.processed_messages
--     ADD COLUMN IF NOT EXISTS tenant_id BIGINT REFERENCES public.tenants (id) ON DELETE CASCADE;
--
-- The migration performs the same add-if-missing operation for an empty table,
-- then refuses to continue if any row is still unmapped.  Existing claims are
-- preserved; tenant ownership must come from an operator-approved source.

-- Keep the reconciliation check and every key change in one DO transaction.
-- This makes the lock effective under both a migration transaction and plain
-- psql autocommit, and prevents an old unscoped writer from racing the change.
DO $migration$
DECLARE
    tenant_attribute SMALLINT;
    wamid_attribute SMALLINT;
    unmapped_claim_count BIGINT;
BEGIN
    LOCK TABLE public.processed_messages IN SHARE ROW EXCLUSIVE MODE;
    LOCK TABLE public.webhook_jobs IN SHARE ROW EXCLUSIVE MODE;

    -- processed_messages is server-only. Add the nullable compatibility
    -- column first so an operator can reconcile old rows before the key is
    -- installed.
    ALTER TABLE public.processed_messages
        ADD COLUMN IF NOT EXISTS tenant_id BIGINT REFERENCES public.tenants (id) ON DELETE CASCADE;

    -- Fail closed instead of guessing ownership or dropping an idempotency
    -- claim. The count is safe to expose; message ids and other tenant data
    -- are not.
    SELECT count(*)
    INTO unmapped_claim_count
    FROM public.processed_messages
    WHERE tenant_id IS NULL;

    IF unmapped_claim_count > 0 THEN
        RAISE EXCEPTION
            'processed_messages contains % legacy claim(s) without tenant_id; operator reconciliation is required before migration 0011. Claims were not deleted.',
            unmapped_claim_count
            USING
                ERRCODE = 'P0001',
                HINT = 'Reconcile every legacy claim to a valid tenants.id in a pre-migration transaction, verify no NULL tenant_id remains, then rerun 0011.';
    END IF;

    -- Make the new tenant dimension mandatory. This is safe only after the
    -- fail-closed reconciliation gate above succeeds.
    ALTER TABLE public.processed_messages
        ALTER COLUMN tenant_id SET NOT NULL;

    -- Keep the foreign key explicit even when an operator pre-staged the
    -- column manually without using the inline REFERENCES clause.
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.processed_messages'::regclass
          AND conname = 'processed_messages_tenant_id_fkey'
          AND contype = 'f'
    ) THEN
        ALTER TABLE public.processed_messages
            ADD CONSTRAINT processed_messages_tenant_id_fkey
            FOREIGN KEY (tenant_id) REFERENCES public.tenants (id) ON DELETE CASCADE;
    END IF;

    -- Replace the old wamid-only primary key with the tenant-scoped key. The
    -- conditional check keeps a second application from rebuilding an already
    -- correct key.
    SELECT attnum
    INTO tenant_attribute
    FROM pg_attribute
    WHERE attrelid = 'public.processed_messages'::regclass
      AND attname = 'tenant_id'
      AND NOT attisdropped;

    SELECT attnum
    INTO wamid_attribute
    FROM pg_attribute
    WHERE attrelid = 'public.processed_messages'::regclass
      AND attname = 'wamid'
      AND NOT attisdropped;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.processed_messages'::regclass
          AND contype = 'p'
          AND conkey = ARRAY[tenant_attribute, wamid_attribute]::SMALLINT[]
    ) THEN
        ALTER TABLE public.processed_messages
            DROP CONSTRAINT IF EXISTS processed_messages_pkey;
        ALTER TABLE public.processed_messages
            ADD CONSTRAINT processed_messages_pkey PRIMARY KEY (tenant_id, wamid);
    END IF;

    -- 0004 installed a global wamid unique constraint. 0008 intentionally
    -- keeps legacy NULL-tenant job rows quarantined; this migration changes
    -- only the uniqueness boundary and leaves that check/worker behavior
    -- untouched. Add the composite constraint before removing the old one so
    -- a non-transactional failure cannot leave the table unconstrained.
    SELECT attnum
    INTO tenant_attribute
    FROM pg_attribute
    WHERE attrelid = 'public.webhook_jobs'::regclass
      AND attname = 'tenant_id'
      AND NOT attisdropped;

    SELECT attnum
    INTO wamid_attribute
    FROM pg_attribute
    WHERE attrelid = 'public.webhook_jobs'::regclass
      AND attname = 'wamid'
      AND NOT attisdropped;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.webhook_jobs'::regclass
          AND contype = 'u'
          AND conkey = ARRAY[tenant_attribute, wamid_attribute]::SMALLINT[]
    ) THEN
        ALTER TABLE public.webhook_jobs
            ADD CONSTRAINT webhook_jobs_tenant_wamid_key
            UNIQUE (tenant_id, wamid);
    END IF;

    ALTER TABLE public.webhook_jobs
        DROP CONSTRAINT IF EXISTS webhook_jobs_wamid_key;
END;
$migration$;

-- Reassert 0008's server-only processed_messages contract after the key
-- change. No authenticated/anon policy is introduced; service_role is the
-- only intended DML role and bypasses RLS in the deployment model.
ALTER TABLE public.processed_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.processed_messages FROM anon, authenticated;
REVOKE ALL ON public.processed_messages FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.processed_messages TO service_role;

COMMENT ON TABLE public.processed_messages IS
    'Server-only tenant-scoped inbound idempotency claims; legacy rows require operator tenant reconciliation before this key can be installed.';
COMMENT ON COLUMN public.processed_messages.tenant_id IS
    'Owning tenant for the claim; must be present before the composite primary key is installed.';
COMMENT ON COLUMN public.webhook_jobs.tenant_id IS
    'Owning tenant for the PII-free worker job; legacy NULL rows remain quarantined by 0008.';
