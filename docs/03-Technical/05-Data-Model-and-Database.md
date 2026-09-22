# 05 — Data Model and Database

> Sumber: subagent deep-research data (Supabase RLS docs, PlanetScale tenancy, Voxire soft-delete; Sep 2026). Skema = sintesis rekomendasi, bukan klaim vendor.

## Skema minimal (Postgres, shared-schema `tenant_id`)

- `tenants(id, name, created_at, updated_at)`; semua tabel bisnis: `tenant_id NOT NULL + FK` + index leading `(tenant_id, ...)`. `tenant_id BIGINT` kompak; schema/db-per-tenant DITOLAK >ratusan tenant (katalog, migrasi, pooling).
- `memberships(tenant_id, user_id, role, created_at)` — otorisasi; jangan andalkan `auth.uid()` saja.
- `services/resources(id, tenant_id, name, duration_min, capacity, created_at, updated_at, deleted_at)`.
- `appointments(id uuid default gen_random_uuid(), tenant_id, resource_id, customer ref minimised, status: held/confirmed/cancelled/completed/no_show, starts_at/ends_at timestamptz, hold_expires_at, idempotency_key unique per tenant, deleted_at, created_at, updated_at)` + `CHECK (ends_at > starts_at)` + anti-double-book di service layer + transaksi.
- `appointment_holds(id, tenant_id, resource_id, slot_start/slot_end, token unique, expires_at, created_at)` — TTL 5-10 mnt, worker bersihkan; konfirmasi atomik hold→appointment 1 transaksi.
- `outbox(... aggregate, event_type, payload jsonb minimised, idempotency_key unique, status pending/claimed/sent/failed, available_at, attempts, created_at)` — tulis bareng transaksi bisnis; claim `FOR UPDATE SKIP LOCKED`.
- `audit_log(tenant_id, actor, action, entity, diff jsonb redacted, created_at)` — append-only, tanpa update/delete dari app role.
- `message_log(tenant_id, wa_message_id unique, direction, template_name, status, quality_error, created_at)` — retry, backoff, bukti opt-out.

## Konvensi (fakta pola)

- Tiap tabel `created_at/updated_at timestamptz default now()`; entitas penting + `deleted_at` (jangan hard-delete appointment/audit/message_log).
- RLS Supabase: enable per tabel, revoke grants lalu grant minimal, policy per operasi, `(select auth.uid())` + `with check`, index kolom filter, `security definer` + `set search_path=''`, hindari rekursi (42P17). https://supabase.com/docs/guides/database/postgres/row-level-security
- Soft-delete: partial index `WHERE deleted_at IS NULL`; autovacuum agresif untuk churn tinggi; FK cascade/restrict eksplisit. https://voxire.com/blog/soft-deletes-postgresql-multitenant-saas/
- Defense in depth: filter tenant di app layer + RLS jaring pengaman (bukan salah satu saja). https://planetscale.com/blog/approaches-to-tenancy-in-postgres
