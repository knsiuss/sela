-- 0001_init: multi-tenant scheduling core for Sela.
-- Conventions: timestamptz everywhere, soft delete on business entities,
-- idempotency keys unique per tenant, append-only audit log.
-- Apply with: psql "$DATABASE_URL" -f 0001_init.sql

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "btree_gist";

CREATE TABLE tenants (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
    tenant_id   BIGINT NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    user_id     UUID NOT NULL,
    role        TEXT NOT NULL CHECK (role IN ('owner', 'staff', 'viewer')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE services (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id     BIGINT NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    duration_min  INTEGER NOT NULL CHECK (duration_min > 0),
    price_cents   INTEGER NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at    TIMESTAMPTZ,
    UNIQUE (tenant_id, name)
);

CREATE TABLE resources (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    capacity    INTEGER NOT NULL DEFAULT 1 CHECK (capacity > 0),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at  TIMESTAMPTZ,
    UNIQUE (tenant_id, name)
);

CREATE TABLE appointments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       BIGINT NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    resource_id     BIGINT REFERENCES resources (id) ON DELETE RESTRICT,
    service_id      BIGINT REFERENCES services (id) ON DELETE RESTRICT,
    customer_ref    TEXT NOT NULL,
    status          TEXT NOT NULL CHECK (status IN ('held', 'confirmed', 'cancelled', 'completed', 'no_show')),
    starts_at       TIMESTAMPTZ NOT NULL,
    ends_at         TIMESTAMPTZ NOT NULL,
    hold_expires_at TIMESTAMPTZ,
    idempotency_key TEXT NOT NULL,
    deleted_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (ends_at > starts_at),
    UNIQUE (tenant_id, idempotency_key)
);

-- Last line of defense: overlapping confirmed/held slots for one resource
-- are structurally impossible. Application layer must still check first
-- for friendly errors; this constraint is the backstop, not the UX.
ALTER TABLE appointments
    ADD CONSTRAINT no_overlapping_slots
    EXCLUDE USING gist (
        resource_id WITH =,
        tstzrange(starts_at, ends_at, '[)') WITH &&
    )
    WHERE (status IN ('held', 'confirmed') AND deleted_at IS NULL);

CREATE INDEX appointments_active_idx ON appointments (tenant_id, starts_at)
    WHERE (deleted_at IS NULL);

CREATE TABLE appointment_holds (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    resource_id BIGINT NOT NULL REFERENCES resources (id) ON DELETE CASCADE,
    slot_start  TIMESTAMPTZ NOT NULL,
    slot_end    TIMESTAMPTZ NOT NULL,
    token       TEXT NOT NULL UNIQUE,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (slot_end > slot_start)
);

CREATE TABLE outbox (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id       BIGINT NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    aggregate_type  TEXT NOT NULL,
    aggregate_id    TEXT NOT NULL,
    event_type      TEXT NOT NULL,
    payload         JSONB NOT NULL,
    idempotency_key TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'claimed', 'sent', 'failed')),
    available_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    claimed_at      TIMESTAMPTZ,
    attempts        INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE audit_log (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   BIGINT NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    actor       TEXT NOT NULL,
    action      TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id   TEXT NOT NULL,
    diff        JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Append-only: grant no UPDATE/DELETE on audit_log to the app role.

CREATE TABLE message_log (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id       BIGINT NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    wa_message_id   TEXT NOT NULL UNIQUE,
    direction       TEXT NOT NULL CHECK (direction IN ('in', 'out')),
    template_name   TEXT,
    status          TEXT NOT NULL CHECK (status IN ('sent', 'delivered', 'read', 'failed')),
    quality_error   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
