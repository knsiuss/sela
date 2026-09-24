-- 0010_reschedule_sessions: PII-minimal tenant/conversation button-flow state.
-- Apply after 0009_worker_leases.sql. Raw message text, sender references, and
-- recipient data remain confined to inbound_messages and are never copied here.

CREATE OR REPLACE FUNCTION public.is_valid_reschedule_candidate_slots(value JSONB)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
    SELECT CASE
        WHEN pg_catalog.jsonb_typeof(value) = 'array' THEN
            pg_catalog.jsonb_array_length(value) <= 3
            AND pg_catalog.octet_length(value::TEXT) <= 8192
            AND NOT EXISTS (
                SELECT 1
                FROM pg_catalog.jsonb_array_elements(value) AS elements(slot)
                WHERE pg_catalog.jsonb_typeof(slot) <> 'object'
                   OR pg_catalog.jsonb_typeof(slot -> 'id') <> 'string'
                   OR pg_catalog.jsonb_typeof(slot -> 'start_iso') <> 'string'
                   OR pg_catalog.jsonb_typeof(slot -> 'end_iso') <> 'string'
                   OR char_length(slot ->> 'id') NOT BETWEEN 1 AND 256
                   OR char_length(slot ->> 'start_iso') NOT BETWEEN 1 AND 64
                   OR char_length(slot ->> 'end_iso') NOT BETWEEN 1 AND 64
                   OR (slot ? 'staff' AND pg_catalog.jsonb_typeof(slot -> 'staff') <> 'string')
                   OR (slot ? 'resource' AND pg_catalog.jsonb_typeof(slot -> 'resource') <> 'string')
                   OR char_length(slot ->> 'staff') > 128
                   OR char_length(slot ->> 'resource') > 128
                   OR (slot - ARRAY['id', 'start_iso', 'end_iso', 'staff', 'resource']::TEXT[])
                      <> '{}'::JSONB
            )
        ELSE FALSE
    END
$$;

REVOKE ALL ON FUNCTION public.is_valid_reschedule_candidate_slots(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_valid_reschedule_candidate_slots(JSONB) TO service_role;

CREATE TABLE IF NOT EXISTS public.reschedule_sessions (
    id                       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id                BIGINT NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    conversation_id          TEXT NOT NULL CHECK (char_length(conversation_id) BETWEEN 1 AND 128),
    phase                    TEXT NOT NULL CHECK (
        phase IN ('offered', 'awaiting_confirmation', 'confirmed', 'cancelled', 'handoff')
    ),
    candidate_slots          JSONB NOT NULL DEFAULT '[]'::jsonb,
    chosen_slot_id           TEXT CHECK (chosen_slot_id IS NULL OR char_length(chosen_slot_id) BETWEEN 1 AND 256),
    hold_id                  TEXT CHECK (hold_id IS NULL OR char_length(hold_id) BETWEEN 1 AND 256),
    hold_expires_at_iso      TIMESTAMPTZ,
    offer_generation         INTEGER NOT NULL DEFAULT 1 CHECK (offer_generation BETWEEN 1 AND 2147483647),
    last_wamid               TEXT CHECK (last_wamid IS NULL OR char_length(last_wamid) BETWEEN 1 AND 128),
    version                  INTEGER NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 2147483647),
    expires_at               TIMESTAMPTZ NOT NULL,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, conversation_id),
    CHECK (expires_at > created_at),
    CHECK (public.is_valid_reschedule_candidate_slots(candidate_slots)),
    CHECK (
        phase <> 'awaiting_confirmation'
        OR (chosen_slot_id IS NOT NULL AND hold_id IS NOT NULL AND hold_expires_at_iso IS NOT NULL)
    ),
    CHECK (
        phase NOT IN ('offered', 'confirmed', 'cancelled', 'handoff')
        OR (hold_id IS NULL AND hold_expires_at_iso IS NULL)
    )
);

COMMENT ON TABLE public.reschedule_sessions IS
    'PII-minimal reschedule state keyed by tenant and opaque conversation id; excludes message text, sender references, and recipients.';

COMMENT ON COLUMN public.reschedule_sessions.candidate_slots IS
    'Bounded JSON array of at most three slot objects containing only id, start_iso, end_iso, staff, and resource fields.';

COMMENT ON COLUMN public.reschedule_sessions.version IS
    'Optimistic compare-and-swap version; writers must update the exact version they loaded.';

-- Cleanup scans only the small expired tail; active rows are addressed by the
-- compound unique key and the existing tenant foreign-key index.
CREATE INDEX IF NOT EXISTS reschedule_sessions_expiry_idx
    ON public.reschedule_sessions (expires_at);

ALTER TABLE public.reschedule_sessions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.reschedule_sessions FROM anon, authenticated;
GRANT SELECT ON public.reschedule_sessions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.reschedule_sessions TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.reschedule_sessions_id_seq TO service_role;

DROP POLICY IF EXISTS reschedule_sessions_select_tenant ON public.reschedule_sessions;
CREATE POLICY reschedule_sessions_select_tenant ON public.reschedule_sessions
    FOR SELECT TO authenticated
    USING (tenant_id = (SELECT public.current_tenant_id()));
