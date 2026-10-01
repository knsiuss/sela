-- 0012_durable_calendar_reschedule: durable holds, operation reconciliation,
-- and an atomic tenant-scoped reschedule contract. Apply after 0011.
--
-- ROLLOUT: stop calendar writers, back up, apply, then deploy the matching
-- application. Legacy appointment_holds rows remain contract_version 1 and are
-- never interpreted as v2 holds. Do not delete them to force a migration.
--
-- ROLLBACK: the new writer must be stopped before code rollback. The new tables
-- and nullable columns may remain while the previous application is restored;
-- never drop appointment/audit evidence to roll back application code.

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
                   OR (slot ? 'resource_id' AND pg_catalog.jsonb_typeof(slot -> 'resource_id') <> 'string')
                   OR char_length(slot ->> 'staff') > 128
                   OR char_length(slot ->> 'resource') > 128
                   OR COALESCE((slot ->> 'resource_id') ~ '^[1-9][0-9]{0,18}$', TRUE) = FALSE
                   OR (slot - ARRAY[
                       'id', 'start_iso', 'end_iso', 'staff', 'resource', 'resource_id'
                   ]::TEXT[]) <> '{}'::JSONB
            )
        ELSE FALSE
    END
$$;

REVOKE ALL ON FUNCTION public.is_valid_reschedule_candidate_slots(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_valid_reschedule_candidate_slots(JSONB) TO service_role;

ALTER TABLE public.appointments
    ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

-- Resource and appointment ids are globally unique today, but every durable
-- relationship must also prove that both rows belong to the same tenant.
DO $migration$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'appointments_tenant_id_id_key'
          AND conrelid = 'public.appointments'::regclass
          AND contype = 'u'
    ) THEN
        ALTER TABLE public.appointments
            ADD CONSTRAINT appointments_tenant_id_id_key UNIQUE (tenant_id, id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'resources_tenant_id_id_key'
          AND conrelid = 'public.resources'::regclass
          AND contype = 'u'
    ) THEN
        ALTER TABLE public.resources
            ADD CONSTRAINT resources_tenant_id_id_key UNIQUE (tenant_id, id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'appointments_tenant_resource_fk'
          AND conrelid = 'public.appointments'::regclass
          AND contype = 'f'
    ) THEN
        ALTER TABLE public.appointments
            ADD CONSTRAINT appointments_tenant_resource_fk
            FOREIGN KEY (tenant_id, resource_id)
            REFERENCES public.resources (tenant_id, id)
            ON DELETE RESTRICT;
    END IF;
END;
$migration$;

DO $migration$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'appointments_version_bounds_ck'
          AND conrelid = 'public.appointments'::regclass
          AND contype = 'c'
    ) THEN
        ALTER TABLE public.appointments
            ADD CONSTRAINT appointments_version_bounds_ck
            CHECK (version BETWEEN 1 AND 2147483647);
    END IF;
END;
$migration$;

CREATE OR REPLACE FUNCTION public.bump_appointment_version()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    IF OLD.version >= 2147483647 THEN
        RAISE EXCEPTION 'appointment version exhausted for %', OLD.id
            USING ERRCODE = '23514';
    END IF;
    NEW.version := OLD.version + 1;
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.bump_appointment_version() FROM PUBLIC;
DROP TRIGGER IF EXISTS appointments_bump_version ON public.appointments;
CREATE TRIGGER appointments_bump_version
    BEFORE UPDATE ON public.appointments
    FOR EACH ROW
    EXECUTE FUNCTION public.bump_appointment_version();

ALTER TABLE public.appointment_holds
    ADD COLUMN IF NOT EXISTS slot_id TEXT,
    ADD COLUMN IF NOT EXISTS operation_key TEXT,
    ADD COLUMN IF NOT EXISTS appointment_id UUID,
    ADD COLUMN IF NOT EXISTS status TEXT,
    ADD COLUMN IF NOT EXISTS confirmed_appointment_id UUID,
    ADD COLUMN IF NOT EXISTS contract_version SMALLINT NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

DO $migration$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'appointment_holds_tenant_appointment_fk'
          AND conrelid = 'public.appointment_holds'::regclass
          AND contype = 'f'
    ) THEN
        ALTER TABLE public.appointment_holds
            ADD CONSTRAINT appointment_holds_tenant_appointment_fk
            FOREIGN KEY (tenant_id, appointment_id)
            REFERENCES public.appointments (tenant_id, id)
            ON DELETE RESTRICT;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'appointment_holds_tenant_confirmed_appointment_fk'
          AND conrelid = 'public.appointment_holds'::regclass
          AND contype = 'f'
    ) THEN
        ALTER TABLE public.appointment_holds
            ADD CONSTRAINT appointment_holds_tenant_confirmed_appointment_fk
            FOREIGN KEY (tenant_id, confirmed_appointment_id)
            REFERENCES public.appointments (tenant_id, id)
            ON DELETE RESTRICT;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'appointment_holds_v2_contract_ck'
          AND conrelid = 'public.appointment_holds'::regclass
          AND contype = 'c'
    ) THEN
        ALTER TABLE public.appointment_holds
            ADD CONSTRAINT appointment_holds_v2_contract_ck
            CHECK (
                contract_version = 1
                OR (
                    contract_version = 2
                    AND slot_id IS NOT NULL
                    AND char_length(slot_id) BETWEEN 1 AND 256
                    AND operation_key IS NOT NULL
                    AND char_length(operation_key) BETWEEN 1 AND 256
                    AND appointment_id IS NOT NULL
                    AND status IS NOT NULL
                    AND status IN ('held', 'confirmed', 'released', 'expired')
                )
            );
    END IF;
END;
$migration$;

CREATE UNIQUE INDEX IF NOT EXISTS appointment_holds_operation_key_uidx
    ON public.appointment_holds (tenant_id, operation_key)
    WHERE operation_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS appointment_holds_appointment_idx
    ON public.appointment_holds (tenant_id, appointment_id)
    WHERE appointment_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.calendar_operations (
    tenant_id            BIGINT NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
    operation_key        TEXT NOT NULL CHECK (char_length(operation_key) BETWEEN 1 AND 256),
    operation_type       TEXT NOT NULL CHECK (
        operation_type IN ('hold', 'confirm', 'reschedule')
    ),
    request_fingerprint  CHAR(64) NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    result               JSONB NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, operation_key),
    CHECK (pg_catalog.jsonb_typeof(result) = 'object')
);

ALTER TABLE public.calendar_operations
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE public.calendar_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.calendar_operations FROM anon, authenticated;
REVOKE ALL ON public.calendar_operations FROM PUBLIC;
GRANT SELECT, INSERT ON public.calendar_operations TO service_role;

ALTER TABLE public.reschedule_sessions
    ADD COLUMN IF NOT EXISTS appointment_id UUID,
    ADD COLUMN IF NOT EXISTS source_appointment_version INTEGER;

DO $migration$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'reschedule_sessions_tenant_appointment_fk'
          AND conrelid = 'public.reschedule_sessions'::regclass
          AND contype = 'f'
    ) THEN
        ALTER TABLE public.reschedule_sessions
            ADD CONSTRAINT reschedule_sessions_tenant_appointment_fk
            FOREIGN KEY (tenant_id, appointment_id)
            REFERENCES public.appointments (tenant_id, id)
            ON DELETE RESTRICT;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'reschedule_sessions_appointment_source_ck'
          AND conrelid = 'public.reschedule_sessions'::regclass
          AND contype = 'c'
    ) THEN
        ALTER TABLE public.reschedule_sessions
            ADD CONSTRAINT reschedule_sessions_appointment_source_ck
            CHECK (
                (appointment_id IS NULL AND source_appointment_version IS NULL)
                OR (
                    appointment_id IS NOT NULL
                    AND source_appointment_version IS NOT NULL
                    AND source_appointment_version BETWEEN 1 AND 2147483647
                )
            );
    END IF;
END;
$migration$;

CREATE INDEX IF NOT EXISTS reschedule_sessions_appointment_idx
    ON public.reschedule_sessions (tenant_id, appointment_id)
    WHERE appointment_id IS NOT NULL;

ALTER TABLE public.inbound_messages
    ADD COLUMN IF NOT EXISTS appointment_id UUID;

DO $migration$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'inbound_messages_tenant_appointment_fk'
          AND conrelid = 'public.inbound_messages'::regclass
          AND contype = 'f'
    ) THEN
        ALTER TABLE public.inbound_messages
            ADD CONSTRAINT inbound_messages_tenant_appointment_fk
            FOREIGN KEY (tenant_id, appointment_id)
            REFERENCES public.appointments (tenant_id, id)
            ON DELETE RESTRICT;
    END IF;
END;
$migration$;

CREATE INDEX IF NOT EXISTS inbound_messages_appointment_idx
    ON public.inbound_messages (tenant_id, appointment_id)
    WHERE appointment_id IS NOT NULL;

COMMENT ON TABLE public.calendar_operations IS
    'Server-only committed calendar operation results used to resolve retries after an ambiguous database commit; contains no message or recipient data.';
COMMENT ON COLUMN public.appointments.version IS
    'Optimistic source version incremented by trigger for every update.';
COMMENT ON COLUMN public.appointment_holds.contract_version IS
    'Version 1 rows are legacy and are never interpreted as durable v2 holds; version 2 requires appointment ownership, operation key, and target slot.';
COMMENT ON COLUMN public.reschedule_sessions.appointment_id IS
    'Trusted source appointment selected by server-side context; never inferred from customer free text.';
COMMENT ON COLUMN public.inbound_messages.appointment_id IS
    'Optional trusted appointment context attached by a server-side workflow, never parsed from the customer message body.';
