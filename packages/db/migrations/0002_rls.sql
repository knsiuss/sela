-- 0002_rls: tenant-isolation Row Level Security for Sela.
-- Contract: application opens a transaction, verifies the caller's membership
-- for the tenant, then runs SET LOCAL app.current_tenant = '<tenant_id>'.
-- SET LOCAL is transaction-scoped, so the value cannot leak into the next
-- request reusing the pooled connection. Every policy below compares the
-- row's tenant against that value and fails closed (no rows) when it is
-- missing or invalid. RLS is a safety net; the app layer must still filter
-- by tenant for correct UX and defense in depth.
-- Apply with: psql "$DATABASE_URL" -f 0002_rls.sql
-- Does not touch 0001_init.sql objects except adding policies/grants/indexes.

-- Tenant reader used by every policy. SECURITY DEFINER so policy checks
-- bypass RLS on membership-adjacent reads and cannot recurse (Postgres
-- error 42P17). Empty search_path plus schema-qualified names keep the
-- function immune to search_path hijacking. Invalid GUC values return NULL
-- (deny) instead of raising mid-query.
CREATE OR REPLACE FUNCTION public.current_tenant_id()
RETURNS BIGINT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    raw_value TEXT;
    tenant_value BIGINT;
BEGIN
    raw_value := pg_catalog.current_setting('app.current_tenant', TRUE);
    IF raw_value IS NULL OR raw_value = '' THEN
        RETURN NULL;
    END IF;
    BEGIN
        tenant_value := raw_value::BIGINT;
    EXCEPTION WHEN invalid_text_representation THEN
        RETURN NULL;
    END;
    IF tenant_value IS NULL OR tenant_value <= 0 THEN
        RETURN NULL;
    END IF;
    RETURN tenant_value;
END;
$$;

COMMENT ON FUNCTION public.current_tenant_id() IS
    'Transaction tenant from app.current_tenant GUC; NULL means deny.';

REVOKE ALL ON FUNCTION public.current_tenant_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_tenant_id() TO authenticated, service_role;

-- Enable RLS on every business table, including append-only logs, so no
-- table is left open when a new role or client is added later.
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.services ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.appointment_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_log ENABLE ROW LEVEL SECURITY;

-- Start from zero grants, then open only what the app role needs.
-- service_role bypasses RLS and keeps admin/cleanup powers; anon gets nothing.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;

-- Tenants can be read and renamed by their own members; creation and
-- deletion stay with service_role so tenants cannot fork or drop themselves.
GRANT SELECT, UPDATE ON public.tenants TO authenticated;
-- Memberships are read-only for the app role; role changes go through a
-- privileged transaction (service_role) to avoid self-promotion.
GRANT SELECT ON public.memberships TO authenticated;
-- Ephemeral scheduling state is fully managed by the app within its tenant.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.services TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.resources TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.appointments TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.appointment_holds TO authenticated;
-- Outbox rows are produced and claimed by the app; retention purges run as
-- service_role, so the app role gets no DELETE here.
GRANT SELECT, INSERT, UPDATE ON public.outbox TO authenticated;
-- Audit log is append-only by design (see 0001_init.sql): no UPDATE/DELETE.
GRANT SELECT, INSERT ON public.audit_log TO authenticated;
-- Message log keeps delivery evidence: app may insert and update status,
-- but must never hard-delete rows (soft-delete convention for evidence).
GRANT SELECT, INSERT, UPDATE ON public.message_log TO authenticated;

-- Identity columns need sequence usage for INSERT ... RETURNING id.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

-- Tenants: a member sees only its own tenant row.
DROP POLICY IF EXISTS tenants_select_tenant ON public.tenants;
CREATE POLICY tenants_select_tenant ON public.tenants
    FOR SELECT TO authenticated
    USING (id = (SELECT public.current_tenant_id()));

-- Tenant rename must keep the row on the same tenant (no id hopping).
DROP POLICY IF EXISTS tenants_update_tenant ON public.tenants;
CREATE POLICY tenants_update_tenant ON public.tenants
    FOR UPDATE TO authenticated
    USING (id = (SELECT public.current_tenant_id()))
    WITH CHECK (id = (SELECT public.current_tenant_id()));

-- Memberships: members can list their own tenant roster, nothing more.
DROP POLICY IF EXISTS memberships_select_tenant ON public.memberships;
CREATE POLICY memberships_select_tenant ON public.memberships
    FOR SELECT TO authenticated
    USING (tenant_id = (SELECT public.current_tenant_id()));

-- Services: full lifecycle scoped to the transaction tenant.
DROP POLICY IF EXISTS services_select_tenant ON public.services;
CREATE POLICY services_select_tenant ON public.services
    FOR SELECT TO authenticated
    USING (tenant_id = (SELECT public.current_tenant_id()));
DROP POLICY IF EXISTS services_insert_tenant ON public.services;
CREATE POLICY services_insert_tenant ON public.services
    FOR INSERT TO authenticated
    WITH CHECK (tenant_id = (SELECT public.current_tenant_id()));
DROP POLICY IF EXISTS services_update_tenant ON public.services;
CREATE POLICY services_update_tenant ON public.services
    FOR UPDATE TO authenticated
    USING (tenant_id = (SELECT public.current_tenant_id()))
    WITH CHECK (tenant_id = (SELECT public.current_tenant_id()));
DROP POLICY IF EXISTS services_delete_tenant ON public.services;
CREATE POLICY services_delete_tenant ON public.services
    FOR DELETE TO authenticated
    USING (tenant_id = (SELECT public.current_tenant_id()));

-- Resources: same tenant-scoped lifecycle as services.
DROP POLICY IF EXISTS resources_select_tenant ON public.resources;
CREATE POLICY resources_select_tenant ON public.resources
    FOR SELECT TO authenticated
    USING (tenant_id = (SELECT public.current_tenant_id()));
DROP POLICY IF EXISTS resources_insert_tenant ON public.resources;
CREATE POLICY resources_insert_tenant ON public.resources
    FOR INSERT TO authenticated
    WITH CHECK (tenant_id = (SELECT public.current_tenant_id()));
DROP POLICY IF EXISTS resources_update_tenant ON public.resources;
CREATE POLICY resources_update_tenant ON public.resources
    FOR UPDATE TO authenticated
    USING (tenant_id = (SELECT public.current_tenant_id()))
    WITH CHECK (tenant_id = (SELECT public.current_tenant_id()));
DROP POLICY IF EXISTS resources_delete_tenant ON public.resources;
CREATE POLICY resources_delete_tenant ON public.resources
    FOR DELETE TO authenticated
    USING (tenant_id = (SELECT public.current_tenant_id()));

-- Appointments: writes pin tenant_id on both sides so a row can never be
-- moved into another tenant via UPDATE.
DROP POLICY IF EXISTS appointments_select_tenant ON public.appointments;
CREATE POLICY appointments_select_tenant ON public.appointments
    FOR SELECT TO authenticated
    USING (tenant_id = (SELECT public.current_tenant_id()));
DROP POLICY IF EXISTS appointments_insert_tenant ON public.appointments;
CREATE POLICY appointments_insert_tenant ON public.appointments
    FOR INSERT TO authenticated
    WITH CHECK (tenant_id = (SELECT public.current_tenant_id()));
DROP POLICY IF EXISTS appointments_update_tenant ON public.appointments;
CREATE POLICY appointments_update_tenant ON public.appointments
    FOR UPDATE TO authenticated
    USING (tenant_id = (SELECT public.current_tenant_id()))
    WITH CHECK (tenant_id = (SELECT public.current_tenant_id()));
DROP POLICY IF EXISTS appointments_delete_tenant ON public.appointments;
CREATE POLICY appointments_delete_tenant ON public.appointments
    FOR DELETE TO authenticated
    USING (tenant_id = (SELECT public.current_tenant_id()));

-- Appointment holds: short-lived TTL rows, same tenant scoping.
DROP POLICY IF EXISTS appointment_holds_select_tenant ON public.appointment_holds;
CREATE POLICY appointment_holds_select_tenant ON public.appointment_holds
    FOR SELECT TO authenticated
    USING (tenant_id = (SELECT public.current_tenant_id()));
DROP POLICY IF EXISTS appointment_holds_insert_tenant ON public.appointment_holds;
CREATE POLICY appointment_holds_insert_tenant ON public.appointment_holds
    FOR INSERT TO authenticated
    WITH CHECK (tenant_id = (SELECT public.current_tenant_id()));
DROP POLICY IF EXISTS appointment_holds_update_tenant ON public.appointment_holds;
CREATE POLICY appointment_holds_update_tenant ON public.appointment_holds
    FOR UPDATE TO authenticated
    USING (tenant_id = (SELECT public.current_tenant_id()))
    WITH CHECK (tenant_id = (SELECT public.current_tenant_id()));
DROP POLICY IF EXISTS appointment_holds_delete_tenant ON public.appointment_holds;
CREATE POLICY appointment_holds_delete_tenant ON public.appointment_holds
    FOR DELETE TO authenticated
    USING (tenant_id = (SELECT public.current_tenant_id()));

-- Outbox: produce and claim within the tenant; no DELETE policy on purpose.
DROP POLICY IF EXISTS outbox_select_tenant ON public.outbox;
CREATE POLICY outbox_select_tenant ON public.outbox
    FOR SELECT TO authenticated
    USING (tenant_id = (SELECT public.current_tenant_id()));
DROP POLICY IF EXISTS outbox_insert_tenant ON public.outbox;
CREATE POLICY outbox_insert_tenant ON public.outbox
    FOR INSERT TO authenticated
    WITH CHECK (tenant_id = (SELECT public.current_tenant_id()));
DROP POLICY IF EXISTS outbox_update_tenant ON public.outbox;
CREATE POLICY outbox_update_tenant ON public.outbox
    FOR UPDATE TO authenticated
    USING (tenant_id = (SELECT public.current_tenant_id()))
    WITH CHECK (tenant_id = (SELECT public.current_tenant_id()));

-- Audit log: insert evidence and read it back; updates/deletes stay denied
-- (no policy) to keep the log append-only for the app role.
DROP POLICY IF EXISTS audit_log_select_tenant ON public.audit_log;
CREATE POLICY audit_log_select_tenant ON public.audit_log
    FOR SELECT TO authenticated
    USING (tenant_id = (SELECT public.current_tenant_id()));
DROP POLICY IF EXISTS audit_log_insert_tenant ON public.audit_log;
CREATE POLICY audit_log_insert_tenant ON public.audit_log
    FOR INSERT TO authenticated
    WITH CHECK (tenant_id = (SELECT public.current_tenant_id()));

-- Message log: status transitions (sent/delivered/read/failed) are UPDATEs
-- within the tenant; deletes stay denied to preserve delivery evidence.
DROP POLICY IF EXISTS message_log_select_tenant ON public.message_log;
CREATE POLICY message_log_select_tenant ON public.message_log
    FOR SELECT TO authenticated
    USING (tenant_id = (SELECT public.current_tenant_id()));
DROP POLICY IF EXISTS message_log_insert_tenant ON public.message_log;
CREATE POLICY message_log_insert_tenant ON public.message_log
    FOR INSERT TO authenticated
    WITH CHECK (tenant_id = (SELECT public.current_tenant_id()));
DROP POLICY IF EXISTS message_log_update_tenant ON public.message_log;
CREATE POLICY message_log_update_tenant ON public.message_log
    FOR UPDATE TO authenticated
    USING (tenant_id = (SELECT public.current_tenant_id()))
    WITH CHECK (tenant_id = (SELECT public.current_tenant_id()));

-- Soft-delete working sets stay small: active-row queries always filter
-- deleted_at IS NULL, so partial indexes serve them without carrying
-- deleted history. Appointments already has appointments_active_idx in
-- 0001_init.sql; only the missing ones are added here.
CREATE INDEX IF NOT EXISTS services_active_idx
    ON public.services (tenant_id, name)
    WHERE (deleted_at IS NULL);
CREATE INDEX IF NOT EXISTS resources_active_idx
    ON public.resources (tenant_id, name)
    WHERE (deleted_at IS NULL);
