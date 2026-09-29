import { describe, expect, it, vi } from "vitest";
import type { SqlClient } from "../src/persistence/sql_client.js";
import { IngressReconciliationError } from "../src/ingress/reconciliation.js";
import {
  InMemoryIngressRepairRecorder,
  PostgresIngressRepairRecorder,
} from "../src/ingress/repair_audit.js";

const NOW = new Date("2026-09-24T08:30:00.000Z");
const REPAIR = {
  tenant_id: "42",
  wamid: "wamid-repair-1",
  action: "quarantine" as const,
  actor: "operator-7",
  reason: "retained payload missing, awaiting customer resend",
  resulting_state: "needs_repair" as const,
};

describe("ingress repair recorder", () => {
  it("persists parameterized repairs with a server-assigned timestamp", async () => {
    const query = vi.fn(async (_sql: string, values: readonly unknown[]) => ({
      rows: [{
        tenant_id: values[0],
        wamid: values[1],
        action: values[2],
        actor: values[3],
        reason: values[4],
        resulting_state: values[5],
        created_at: "2026-09-24T08:30:00.000Z",
      }],
      rowCount: 1,
    }));
    const recorder = new PostgresIngressRepairRecorder(
      { query } satisfies SqlClient,
      () => new Date("2026-09-24T08:30:00.000Z"),
    );
    const recorded = await recorder.record_repair(REPAIR);
    expect(recorded).toMatchObject({ ...REPAIR, created_at: "2026-09-24T08:30:00.000Z" });
    const [sql, values] = query.mock.calls[0] as unknown as [string, readonly unknown[]];
    expect(sql).toContain("INSERT INTO ingress_repairs");
    expect(values).toHaveLength(7);
    expect(sql).not.toContain("message_text");
  });

  it("rejects unsafe repair input and offers no delete action", async () => {
    const recorder = new InMemoryIngressRepairRecorder(() => NOW);
    await expect(recorder.record_repair({ ...REPAIR, actor: "" })).rejects.toBeInstanceOf(
      IngressReconciliationError,
    );
    await expect(recorder.record_repair({ ...REPAIR, reason: "short" })).rejects.toBeInstanceOf(
      IngressReconciliationError,
    );
    await expect(recorder.record_repair({
      ...REPAIR,
      action: "delete" as never,
    })).rejects.toBeInstanceOf(IngressReconciliationError);
    expect(recorder.all()).toHaveLength(0);
  });

  it("round-trips repairs with defensive copies", async () => {
    const recorder = new InMemoryIngressRepairRecorder(() => NOW);
    const recorded = await recorder.record_repair({ ...REPAIR, action: "dead_letter" });
    expect(recorded.resulting_state).toBe("needs_repair");
    const dead_lettered = await recorder.record_repair({
      ...REPAIR,
      wamid: "wamid-repair-2",
      action: "dead_letter",
      resulting_state: "failed",
    });
    expect(dead_lettered).toMatchObject({ resulting_state: "failed" });
    expect(recorder.all()).toHaveLength(2);
  });

  it("wraps driver failures with safe codes", async () => {
    const recorder = new PostgresIngressRepairRecorder({
      query: vi.fn(async () => {
        throw new Error("password=secret internal SQL");
      }),
    } satisfies SqlClient);
    const error = await recorder.record_repair(REPAIR).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(IngressReconciliationError);
    expect(String(error)).not.toMatch(/secret|internal SQL/);
  });
});
