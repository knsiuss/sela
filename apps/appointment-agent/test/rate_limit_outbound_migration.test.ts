import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../../packages/db/migrations/0013_rate_limit_outbound_ledger.sql", import.meta.url),
  "utf8",
);

describe("0013 tenant rate-limit and outbound ledger migration", () => {
  it("adds tenant-scoped counters and PII-minimal lifecycle tables", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.tenant_rate_limits");
    expect(migration).toContain("PRIMARY KEY (tenant_id, scope, window_bucket)");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.outbound_ledger");
    expect(migration).toContain("'pending', 'sending', 'sent', 'delivered', 'read', 'failed', 'unknown'");
    expect(migration).toContain("PRIMARY KEY (tenant_id, provider, operation_key)");
    expect(migration).toContain("provider_message_id");
    expect(migration).not.toContain("recipient_phone");
    expect(migration).not.toContain("message_body");
    expect(migration).not.toContain("access_token");
  });

  it("enables server-only RLS/grants and adds legal-hold/operator evidence", () => {
    expect(migration).toContain("ALTER TABLE public.outbound_ledger ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("REVOKE ALL ON public.outbound_ledger, public.legal_holds, public.operator_action_audit FROM anon, authenticated, PUBLIC");
    expect(migration).toContain("GRANT SELECT, INSERT, UPDATE ON public.outbound_ledger TO service_role");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.legal_holds");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.operator_action_audit");
  });
});
