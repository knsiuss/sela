-- 0014_inbound_reconciliation: audited repair ledger for orphaned inbound claims.
-- Apply after 0013_rate_limit_outbound_ledger.sql.
--
-- ROLLOUT:
--   1. Apply to a staging database and verify the service_role grant path
--      with the same read-only checks used by db:gate before production.
--   2. Deploy the reconciliation scanner; it only reads claim/job/row joins
--      and inserts repair audit rows. It never deletes or updates claims,
--      inbound rows, or worker jobs.
--
-- ROLLBACK:
--   The table is append-only audit evidence. Dropping it removes repair
--   history, so prefer retaining it; if removal is required, stop the
--   reconciliation pass and the repair command first, export the table,
--   then drop it in a controlled operator transaction.
--
-- The reconciliation queries below cover the three orphan kinds:
--   claim_without_job: a processed_messages claim with no webhook_jobs row.
--   job_without_row:   a pending/claimed webhook_jobs row with no
--                      inbound_messages row.
--   uncommitted_residue: a claim with a retained row but no worker job,
--                      left between provider acceptance and local commit.
--
-- SELECT pm.tenant_id, pm.wamid
-- FROM public.processed_messages AS pm
-- LEFT JOIN public.webhook_jobs AS wj
--   ON wj.tenant_id = pm.tenant_id AND wj.wamid = pm.wamid
-- WHERE wj.id IS NULL;
--
-- SELECT wj.tenant_id, wj.wamid
-- FROM public.webhook_jobs AS wj
-- LEFT JOIN public.inbound_messages AS im
--   ON im.tenant_id = wj.tenant_id AND im.wamid = wj.wamid
-- WHERE wj.status IN ('pending', 'claimed') AND im.id IS NULL;

CREATE TABLE IF NOT EXISTS public.ingress_repairs (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id       BIGINT NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
    wamid           TEXT NOT NULL CHECK (char_length(wamid) BETWEEN 1 AND 128),
    action          TEXT NOT NULL CHECK (action IN ('requeue', 'quarantine', 'dead_letter', 'mark_repaired')),
    actor           TEXT NOT NULL CHECK (char_length(actor) BETWEEN 1 AND 128),
    reason          TEXT NOT NULL CHECK (char_length(reason) BETWEEN 8 AND 512),
    resulting_state TEXT NOT NULL CHECK (
        resulting_state IN ('accepted', 'duplicate', 'reconciling', 'needs_repair', 'failed')
    ),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Operator repair queue is newest-first per tenant; the pending scan uses the
-- needs_repair predicate to find orphans that are still awaiting a repair.
CREATE INDEX IF NOT EXISTS ingress_repairs_tenant_created_idx
    ON public.ingress_repairs (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ingress_repairs_pending_idx
    ON public.ingress_repairs (tenant_id, created_at DESC)
    WHERE resulting_state = 'needs_repair';

ALTER TABLE public.ingress_repairs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ingress_repairs FROM anon, authenticated, PUBLIC;
GRANT SELECT, INSERT ON public.ingress_repairs TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.ingress_repairs_id_seq TO service_role;

-- Authenticated callers may read their own tenant's repair history. They may
-- not insert repairs; the repair command is a server-side audited action.
GRANT SELECT ON public.ingress_repairs TO authenticated;
DROP POLICY IF EXISTS ingress_repairs_select_tenant ON public.ingress_repairs;
CREATE POLICY ingress_repairs_select_tenant ON public.ingress_repairs
    FOR SELECT TO authenticated
    USING (tenant_id = (SELECT public.current_tenant_id()));

COMMENT ON TABLE public.ingress_repairs IS
    'Append-only audited repairs for orphaned inbound claims. Contains actor, reason, and resulting state; never message content or recipient data. Claims are never deleted by reconciliation.';
COMMENT ON COLUMN public.ingress_repairs.action IS
    'Explicit operator action: requeue, quarantine, dead_letter, or mark_repaired. No delete action exists by design.';
