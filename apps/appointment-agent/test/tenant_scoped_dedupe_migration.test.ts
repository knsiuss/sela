import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration_sql = readFileSync(
  new URL("../../../packages/db/migrations/0011_tenant_scoped_dedupe.sql", import.meta.url),
  "utf8",
);
const atomic_ingress_sql = readFileSync(
  new URL("../src/ingress/postgres_atomic_ingress.ts", import.meta.url),
  "utf8",
);

describe("0011 tenant-scoped dedupe migration contract", () => {
  it("installs composite keys without dropping legacy claims", () => {
    expect(migration_sql).toContain("ADD COLUMN IF NOT EXISTS tenant_id");
    expect(migration_sql).toContain("WHERE tenant_id IS NULL");
    expect(migration_sql).toContain("LOCK TABLE public.processed_messages IN SHARE ROW EXCLUSIVE MODE");
    expect(migration_sql).toContain("operator reconciliation is required");
    expect(migration_sql).toContain("Claims were not deleted.");
    expect(migration_sql).toContain("ALTER COLUMN tenant_id SET NOT NULL");
    expect(migration_sql).toContain("PRIMARY KEY (tenant_id, wamid)");
    expect(migration_sql).toContain("DROP CONSTRAINT IF EXISTS webhook_jobs_wamid_key");
    expect(migration_sql).toContain("UNIQUE (tenant_id, wamid)");
    expect(migration_sql.indexOf("RAISE EXCEPTION")).toBeLessThan(
      migration_sql.indexOf("ADD CONSTRAINT processed_messages_pkey"),
    );
    expect(migration_sql).not.toContain("DROP CONSTRAINT IF EXISTS webhook_jobs_tenant_id_required_ck");
  });

  it("retains the server-only processed-message RLS and service-role contract", () => {
    expect(migration_sql).toContain("ALTER TABLE public.processed_messages ENABLE ROW LEVEL SECURITY");
    expect(migration_sql).toContain("REVOKE ALL ON public.processed_messages FROM anon, authenticated");
    expect(migration_sql).toContain("REVOKE ALL ON public.processed_messages FROM PUBLIC");
    expect(migration_sql).toContain(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON public.processed_messages TO service_role",
    );
    expect(migration_sql).not.toMatch(/DELETE\s+FROM\s+public\.processed_messages/i);
  });

  it("keeps atomic ingress SQL aligned with the composite claim key", () => {
    expect(atomic_ingress_sql).toContain("INSERT INTO processed_messages (tenant_id, wamid)");
    expect(atomic_ingress_sql).toContain("ON CONFLICT (tenant_id, wamid) DO NOTHING");
    expect(atomic_ingress_sql).not.toContain("ON CONFLICT (wamid) DO NOTHING");
  });

  it("documents the stop-and-reconcile rollout and non-destructive rollback boundary", () => {
    expect(migration_sql).toContain("ROLLOUT (required)");
    expect(migration_sql).toContain("ROLLBACK");
    expect(migration_sql).toContain("Stop writers");
    expect(migration_sql).toContain("Never delete a claim");
  });
});
