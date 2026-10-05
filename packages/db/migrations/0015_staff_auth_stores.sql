-- 0015_staff_auth_stores: durable storage for the staff OAuth boundary.
-- Apply after 0014_inbound_reconciliation.sql.
--
-- These three tables exist because the authorization `state`, the staff session,
-- and the Calendar grant were previously process-local. A callback landing on a
-- second instance returned `oauth_state_unknown`, a logout was honoured only by
-- the instance that received it, and every tenant's encrypted refresh token was
-- lost on redeploy. Moving them behind these tables is what makes the dashboard
-- safe to scale horizontally and safe to restart.
--
-- Nothing here is readable by `anon` or `authenticated`. The session cookie is a
-- bearer credential, the state row carries the PKCE verifier for a pending code
-- exchange, and the grant row carries an encrypted long-lived refresh token: all
-- three are server-only by construction, not by convention.
--
-- PII: none. Subjects are the identity provider's opaque subject ids, device
-- identifiers are one-way hashes, and no email address, phone number, name, or
-- client secret is stored in any column.
--
-- ROLLOUT: apply the migration first, deploy the application that reads and
-- writes these tables, then start more than one instance. Do not run two
-- application versions against one database while the older one still keeps
-- in-memory stores: the older instance will not see a state, session, or revoke
-- the newer one handled.
--
-- ROLLBACK: stop the dashboard, restore the previous application, and leave the
-- tables in place. Never drop them to roll back code: they hold the only copy of
-- live staff sessions and encrypted tenant grants. Rows age out on their own TTL
-- (states) and by explicit revocation (sessions and grants).

CREATE TABLE IF NOT EXISTS public.oauth_authorization_states (
    state_hash      CHAR(64) NOT NULL CHECK (state_hash ~ '^[0-9a-f]{64}$'),
    purpose         TEXT NOT NULL CHECK (purpose IN ('staff_login', 'calendar_consent')),
    idp             TEXT NOT NULL CHECK (idp IN ('supabase', 'google')),
    tenant_id       BIGINT REFERENCES public.tenants (id) ON DELETE CASCADE,
    return_path     TEXT NOT NULL CHECK (
                        return_path ~ '^/[A-Za-z0-9][A-Za-z0-9/_-]{0,127}$'
                        AND return_path NOT LIKE '%//%'
                        AND return_path NOT LIKE '%..%'
                        AND return_path NOT LIKE '%\\%'
                    ),
    -- The PKCE verifier and nonce are the secrets of a flow that has not
    -- completed. They live only for the row's TTL and are never logged.
    code_verifier   TEXT NOT NULL CHECK (char_length(code_verifier) BETWEEN 43 AND 128),
    nonce           TEXT NOT NULL CHECK (char_length(nonce) BETWEEN 16 AND 256),
    issued_at       TIMESTAMPTZ NOT NULL,
    expires_at      TIMESTAMPTZ NOT NULL,
    consumed_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (state_hash),
    CHECK (expires_at > issued_at),
    CHECK (tenant_id IS NULL OR purpose = 'calendar_consent'),
    CHECK (consumed_at IS NULL OR consumed_at >= issued_at)
);

-- Drives the pruner that reclaims rows past their replay grace window.
CREATE INDEX IF NOT EXISTS oauth_authorization_states_expiry_idx
    ON public.oauth_authorization_states (expires_at);

CREATE INDEX IF NOT EXISTS oauth_authorization_states_in_flight_idx
    ON public.oauth_authorization_states (issued_at)
    WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS public.staff_sessions (
    session_id           TEXT NOT NULL CHECK (char_length(session_id) BETWEEN 1 AND 256),
    subject_id           TEXT NOT NULL CHECK (char_length(subject_id) BETWEEN 1 AND 256),
    issuer               TEXT NOT NULL CHECK (char_length(issuer) BETWEEN 1 AND 512),
    idp                  TEXT NOT NULL CHECK (idp IN ('supabase', 'google')),
    -- SHA-256 of the cookie secret. The cookie half is never stored, so a row
    -- copy cannot be replayed as a session cookie.
    secret_hash          CHAR(64) NOT NULL CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
    has_mfa              BOOLEAN NOT NULL,
    tenant_roles         JSONB NOT NULL CHECK (
                            pg_catalog.jsonb_typeof(tenant_roles) = 'object'
                            AND pg_catalog.octet_length(tenant_roles::TEXT) <= 8192
                        ),
    tenant_id            BIGINT NOT NULL CHECK (tenant_id > 0),
    -- One-way hash of a per-request device identifier; the raw value is dropped.
    device_hash          CHAR(64) NOT NULL CHECK (device_hash ~ '^[0-9a-f]{64}$'),
    session_created_at   TIMESTAMPTZ NOT NULL,
    session_last_seen_at TIMESTAMPTZ NOT NULL,
    session_revoked_at   TIMESTAMPTZ,
    expires_at           TIMESTAMPTZ NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id),
    CHECK (session_revoked_at IS NULL OR session_revoked_at >= session_created_at),
    CHECK (expires_at > session_created_at)
);

CREATE INDEX IF NOT EXISTS staff_sessions_subject_idx
    ON public.staff_sessions (subject_id, session_last_seen_at DESC);

CREATE INDEX IF NOT EXISTS staff_sessions_expiry_idx
    ON public.staff_sessions (expires_at);

CREATE TABLE IF NOT EXISTS public.google_token_grants (
    grant_id                 TEXT NOT NULL CHECK (char_length(grant_id) BETWEEN 1 AND 256),
    tenant_id                BIGINT NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
    google_subject_id        TEXT NOT NULL CHECK (char_length(google_subject_id) BETWEEN 1 AND 256),
    authorized_by_subject_id TEXT NOT NULL CHECK (char_length(authorized_by_subject_id) BETWEEN 1 AND 256),
    scopes                   TEXT[] NOT NULL CHECK (cardinality(scopes) BETWEEN 1 AND 16),
    -- AES-256-GCM envelope only. The envelope version prefix is checked here as
    -- well as in the application so a plaintext token cannot land in this column
    -- even through a direct write.
    encrypted_refresh_token  TEXT NOT NULL CHECK (
                                char_length(encrypted_refresh_token) BETWEEN 1 AND 2048
                                AND encrypted_refresh_token ~ '^s1\.[A-Za-z0-9_-]{1,64}\.'
                            ),
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at             TIMESTAMPTZ,
    revoked_at               TIMESTAMPTZ,
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (grant_id),
    CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

-- One active grant per tenant: re-consent replaces rather than accumulates, which
-- keeps the tenant-to-account mapping single-valued and auditable.
CREATE UNIQUE INDEX IF NOT EXISTS google_token_grants_active_uidx
    ON public.google_token_grants (tenant_id)
    WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS google_token_grants_tenant_idx
    ON public.google_token_grants (tenant_id, created_at DESC);

ALTER TABLE public.oauth_authorization_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.google_token_grants ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.oauth_authorization_states FROM anon, authenticated, PUBLIC;
REVOKE ALL ON public.staff_sessions FROM anon, authenticated, PUBLIC;
REVOKE ALL ON public.google_token_grants FROM anon, authenticated, PUBLIC;

GRANT SELECT, INSERT, DELETE ON public.oauth_authorization_states TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.staff_sessions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.google_token_grants TO service_role;

COMMENT ON TABLE public.oauth_authorization_states IS
    'Server-only single-use authorization state, stored as a SHA-256 hash. Holds the PKCE verifier and nonce for a pending code exchange and expires on its own TTL. Contains no PII.';
COMMENT ON COLUMN public.oauth_authorization_states.state_hash IS
    'SHA-256 hex of the raw state value. The raw value is generated once, placed in the authorize redirect, and never stored or recoverable from this table.';
COMMENT ON COLUMN public.oauth_authorization_states.consumed_at IS
    'Set by a conditional UPDATE that only matches an unconsumed, unexpired row, which is what makes the claim single-use across instances and makes a replay reportable as a replay.';
COMMENT ON TABLE public.staff_sessions IS
    'Server-only staff sessions. Stores the cookie secret hash and a hashed device id, never the cookie value or any PII, so a session can be revoked centrally and survives a restart.';
COMMENT ON COLUMN public.staff_sessions.secret_hash IS
    'SHA-256 hex of the session cookie secret. The session registry key is derived from both cookie halves, so one half cannot address another session''s row.';
COMMENT ON COLUMN public.staff_sessions.has_mfa IS
    'MFA evidence taken from the verified ID token. Never inferred, never defaulted true.';
COMMENT ON TABLE public.google_token_grants IS
    'Server-only per-tenant Google Calendar grants holding only an encrypted refresh token. Decryption is bound to tenant and purpose by the application, so a row copied across tenants fails closed.';
COMMENT ON COLUMN public.google_token_grants.encrypted_refresh_token IS
    'Tenant- and purpose-bound AES-256-GCM envelope. A plaintext refresh token must never reach this column; the CHECK rejects any value that is not a versioned envelope.';
COMMENT ON COLUMN public.google_token_grants.revoked_at IS
    'Set when the grant is withdrawn. Revocation is two-sided: Google is asked to invalidate the credential first, so a failed upstream revoke leaves this row resolvable and retryable.';
