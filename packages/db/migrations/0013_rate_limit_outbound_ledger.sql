-- 0013_rate_limit_outbound_ledger: tenant-scoped admission control and a
-- durable, PII-minimal outbound delivery ledger.
-- Apply after 0012_durable_calendar_reschedule.sql.
--
-- The application never stores a recipient, message body, access token, or
-- provider response body in these tables. The operation key is derived from
-- bounded provider/job identifiers and is safe to index and replay.

CREATE TABLE IF NOT EXISTS public.tenant_rate_limits (
    tenant_id       BIGINT NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
    scope           TEXT NOT NULL CHECK (scope IN ('webhook', 'outbound', 'operator')),
    window_bucket   BIGINT NOT NULL CHECK (window_bucket >= 0),
    request_count   INTEGER NOT NULL CHECK (request_count > 0),
    limit_count     INTEGER NOT NULL CHECK (limit_count > 0),
    window_seconds  INTEGER NOT NULL CHECK (window_seconds BETWEEN 1 AND 86400),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, scope, window_bucket)
);

CREATE INDEX IF NOT EXISTS tenant_rate_limits_expiry_idx
    ON public.tenant_rate_limits (window_bucket, scope);

ALTER TABLE public.tenant_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tenant_rate_limits FROM anon, authenticated, PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_rate_limits TO service_role;

CREATE TABLE IF NOT EXISTS public.outbound_ledger (
    tenant_id              BIGINT NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
    provider               TEXT NOT NULL CHECK (provider ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
    operation_key          TEXT NOT NULL CHECK (char_length(operation_key) BETWEEN 1 AND 256),
    request_fingerprint    CHAR(64) NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    inbound_wamid          TEXT CHECK (inbound_wamid IS NULL OR char_length(inbound_wamid) BETWEEN 1 AND 128),
    turn_id                TEXT CHECK (turn_id IS NULL OR char_length(turn_id) BETWEEN 1 AND 64),
    status                 TEXT NOT NULL CHECK (
        status IN ('pending', 'sending', 'sent', 'delivered', 'read', 'failed', 'unknown')
    ),
    provider_message_id    TEXT CHECK (
        provider_message_id IS NULL OR char_length(provider_message_id) BETWEEN 1 AND 256
    ),
    provider_status_code   TEXT CHECK (
        provider_status_code IS NULL OR provider_status_code ~ '^[A-Za-z0-9_.:-]{1,64}$'
    ),
    error_code             TEXT CHECK (
        error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,64}$'
    ),
    attempt_count          INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    retryable              BOOLEAN NOT NULL DEFAULT false,
    lease_token            TEXT CHECK (lease_token IS NULL OR char_length(lease_token) BETWEEN 1 AND 256),
    lease_expires_at       TIMESTAMPTZ,
    next_attempt_at        TIMESTAMPTZ,
    last_event_at          TIMESTAMPTZ,
    sent_at                TIMESTAMPTZ,
    delivered_at           TIMESTAMPTZ,
    read_at                TIMESTAMPTZ,
    failed_at              TIMESTAMPTZ,
    unknown_at             TIMESTAMPTZ,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, provider, operation_key),
    CHECK (
        (status <> 'sending')
        OR (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    ),
    CHECK (status <> 'unknown' OR unknown_at IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS outbound_ledger_provider_message_uidx
    ON public.outbound_ledger (tenant_id, provider, provider_message_id)
    WHERE provider_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS outbound_ledger_status_idx
    ON public.outbound_ledger (status, updated_at, tenant_id, provider);

CREATE INDEX IF NOT EXISTS outbound_ledger_lease_idx
    ON public.outbound_ledger (lease_expires_at, status)
    WHERE status = 'sending';

CREATE TABLE IF NOT EXISTS public.legal_holds (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id       BIGINT NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
    scope           TEXT NOT NULL CHECK (scope IN ('inbound', 'outbound', 'audit', 'tenant')),
    reference       TEXT NOT NULL CHECK (char_length(reference) BETWEEN 1 AND 256),
    reason_code     TEXT NOT NULL CHECK (reason_code ~ '^[a-z0-9_]{1,64}$'),
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    released_at     TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS legal_holds_active_uidx
    ON public.legal_holds (tenant_id, scope, reference)
    WHERE is_active;

CREATE TABLE IF NOT EXISTS public.operator_action_audit (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id       BIGINT NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
    actor_subject   TEXT NOT NULL CHECK (char_length(actor_subject) BETWEEN 1 AND 256),
    action          TEXT NOT NULL CHECK (char_length(action) BETWEEN 1 AND 64),
    target_type     TEXT NOT NULL CHECK (char_length(target_type) BETWEEN 1 AND 64),
    target_id       TEXT NOT NULL CHECK (char_length(target_id) BETWEEN 1 AND 256),
    outcome         TEXT NOT NULL CHECK (outcome IN ('allowed', 'denied', 'succeeded', 'failed')),
    reason_code     TEXT CHECK (reason_code IS NULL OR reason_code ~ '^[a-z0-9_]{1,64}$'),
    request_id      TEXT NOT NULL CHECK (char_length(request_id) BETWEEN 1 AND 128),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS operator_action_audit_tenant_created_idx
    ON public.operator_action_audit (tenant_id, created_at DESC);

ALTER TABLE public.outbound_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.legal_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.operator_action_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.outbound_ledger, public.legal_holds, public.operator_action_audit FROM anon, authenticated, PUBLIC;
GRANT SELECT, INSERT, UPDATE ON public.outbound_ledger TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.legal_holds TO service_role;
GRANT SELECT, INSERT ON public.operator_action_audit TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.operator_action_audit_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.legal_holds_id_seq TO service_role;

COMMENT ON TABLE public.tenant_rate_limits IS
    'Server-only fixed-window counters keyed by tenant and bounded scope; no sender, IP, message, or recipient data.';
COMMENT ON TABLE public.outbound_ledger IS
    'Server-only outbound operation and delivery state. Contains provider message ids and safe codes, never recipients, message content, or access tokens.';
COMMENT ON TABLE public.legal_holds IS
    'Tenant-scoped legal hold controls; retention jobs must check active holds before deleting covered data.';
COMMENT ON TABLE public.operator_action_audit IS
    'Append-only operator action evidence; contains actor subject and target ids, never credentials or message content.';
COMMENT ON COLUMN public.outbound_ledger.status IS
    'Lifecycle is pending -> sending -> sent -> delivered/read, with failed and unknown for explicit or ambiguous provider outcomes.';
