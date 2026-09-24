-- 0005_inbound_messages: tenant-scoped channel resolution and retained inbound payloads.
-- Apply after 0004_webhook_jobs.sql.
-- webhook_jobs remains PII-free. Message text and sender references live only in
-- inbound_messages and are deleted by the retention job after expires_at.

CREATE TABLE IF NOT EXISTS tenant_channels (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id         BIGINT NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    channel           TEXT NOT NULL CHECK (char_length(channel) BETWEEN 1 AND 64),
    channel_account_id TEXT NOT NULL CHECK (char_length(channel_account_id) BETWEEN 1 AND 256),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (channel, channel_account_id)
);

CREATE TABLE IF NOT EXISTS inbound_messages (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id       BIGINT NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    wamid           TEXT NOT NULL CHECK (char_length(wamid) BETWEEN 1 AND 128),
    conversation_id TEXT NOT NULL CHECK (char_length(conversation_id) BETWEEN 1 AND 128),
    message_type    TEXT NOT NULL CHECK (char_length(message_type) BETWEEN 1 AND 64),
    sender_ref      TEXT NOT NULL CHECK (char_length(sender_ref) BETWEEN 1 AND 256),
    message_text    TEXT NOT NULL CHECK (char_length(message_text) BETWEEN 1 AND 4096),
    received_at     TIMESTAMPTZ NOT NULL,
    expires_at      TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 days'),
    processed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, wamid),
    CHECK (expires_at > received_at)
);

-- A missing processed_at is the pending work marker for retention queries.
CREATE INDEX IF NOT EXISTS inbound_messages_tenant_received_idx
    ON public.inbound_messages (tenant_id, received_at DESC);

CREATE INDEX IF NOT EXISTS inbound_messages_pending_idx
    ON public.inbound_messages (tenant_id, received_at DESC)
    WHERE processed_at IS NULL;

-- Keep old rows valid while a backfill assigns their tenant. The nullable
-- predicate is deliberate; a row without a tenant must not be claimed.
ALTER TABLE public.webhook_jobs
    ADD COLUMN IF NOT EXISTS tenant_id BIGINT REFERENCES tenants (id);

ALTER TABLE public.webhook_jobs
    ADD COLUMN IF NOT EXISTS available_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE public.webhook_jobs
    ADD COLUMN IF NOT EXISTS last_error TEXT;

CREATE INDEX IF NOT EXISTS webhook_jobs_tenant_created_idx
    ON public.webhook_jobs (tenant_id, created_at, id);

CREATE INDEX IF NOT EXISTS webhook_jobs_tenant_claim_idx
    ON public.webhook_jobs (tenant_id, status, available_at, created_at, id)
    WHERE status = 'pending';

-- The new identity sequence is created by inbound_messages. Grant sequence use
-- explicitly because this migration can be applied after 0002_rls.sql.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

ALTER TABLE public.tenant_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbound_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_jobs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.tenant_channels FROM anon, authenticated;
REVOKE ALL ON public.inbound_messages FROM anon, authenticated;
REVOKE ALL ON public.webhook_jobs FROM anon, authenticated;

-- Authenticated clients may resolve channels and read retained messages for
-- their current tenant. They may not create channel mappings or inbound rows.
GRANT SELECT ON public.tenant_channels TO authenticated;
GRANT SELECT, DELETE ON public.inbound_messages TO authenticated;
GRANT SELECT ON public.webhook_jobs TO authenticated;

-- The server uses service_role for ingress writes, retention, and worker
-- lifecycle updates. Explicit grants keep the contract clear even when roles
-- are customized outside the default Supabase setup.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_channels TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inbound_messages TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.webhook_jobs TO service_role;

DROP POLICY IF EXISTS tenant_channels_select_tenant ON public.tenant_channels;
CREATE POLICY tenant_channels_select_tenant ON public.tenant_channels
    FOR SELECT TO authenticated
    USING (tenant_id = (SELECT public.current_tenant_id()));

DROP POLICY IF EXISTS inbound_messages_select_tenant ON public.inbound_messages;
CREATE POLICY inbound_messages_select_tenant ON public.inbound_messages
    FOR SELECT TO authenticated
    USING (tenant_id = (SELECT public.current_tenant_id()));

-- Retention cleanup is tenant-scoped for authenticated maintenance callers;
-- service_role bypasses RLS for the scheduled server-side purge.
DROP POLICY IF EXISTS inbound_messages_delete_tenant ON public.inbound_messages;
CREATE POLICY inbound_messages_delete_tenant ON public.inbound_messages
    FOR DELETE TO authenticated
    USING (tenant_id = (SELECT public.current_tenant_id()));

DROP POLICY IF EXISTS webhook_jobs_select_tenant ON public.webhook_jobs;
CREATE POLICY webhook_jobs_select_tenant ON public.webhook_jobs
    FOR SELECT TO authenticated
    USING (tenant_id = (SELECT public.current_tenant_id()));
