import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../../packages/db/migrations/0012_durable_calendar_reschedule.sql", import.meta.url),
  "utf8",
);

describe("0012 durable calendar migration contract", () => {
  it("adds optimistic appointment versions and preserves legacy holds", () => {
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1");
    expect(migration).toContain("UNIQUE (tenant_id, id)");
    expect(migration).toContain("FOREIGN KEY (tenant_id, resource_id)");
    expect(migration).toContain("FOREIGN KEY (tenant_id, appointment_id)");
    expect(migration).toContain("CREATE TRIGGER appointments_bump_version");
    expect(migration).toContain("contract_version SMALLINT NOT NULL DEFAULT 1");
    expect(migration).toContain("contract_version = 1");
    expect(migration).toContain("Legacy appointment_holds rows remain contract_version 1");
    expect(migration).toContain("Do not delete them to force a migration");
  });

  it("installs tenant-scoped durable operation and hold uniqueness", () => {
    expect(migration).toContain("PRIMARY KEY (tenant_id, operation_key)");
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()");
    expect(migration).toContain("UNIQUE INDEX IF NOT EXISTS appointment_holds_operation_key_uidx");
    expect(migration).toContain("ON public.appointment_holds (tenant_id, operation_key)");
    expect(migration).toContain("ALTER TABLE public.calendar_operations ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("REVOKE ALL ON public.calendar_operations FROM PUBLIC");
    expect(migration).toContain("GRANT SELECT, INSERT ON public.calendar_operations TO service_role");
    expect(migration).not.toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON public.calendar_operations");
  });

  it("binds trusted appointment context without parsing free text", () => {
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS appointment_id UUID");
    expect(migration).toContain("never parsed from the customer message body");
    expect(migration).toContain("never inferred from customer free text");
    expect(migration).toContain("'resource_id'");
  });
});
