import { describe, expect, it, vi } from "vitest";
import type { SqlClient } from "../src/persistence/sql_client.js";
import { IngressReconciliationError } from "../src/ingress/reconciliation.js";
import {
  InMemoryIngressOrphanScanner,
  PostgresIngressOrphanScanner,
} from "../src/ingress/reconciliation_store.js";
import { ingress_triple } from "./helpers/ingress_fixture.js";

describe("postgres ingress orphan scanner", () => {
  it("scans with a bounded parameterized join and no payload columns", async () => {
    const query = vi.fn(async () => ({
      rows: [{
        tenant_id: 42,
        wamid: "wamid-scan-1",
        has_claim: true,
        has_inbound_row: false,
        job_status: "pending",
        inbound_processed: false,
        observed_at: "2026-09-24T08:00:00.000Z",
      }],
      rowCount: 1,
    }));
    const scanner = new PostgresIngressOrphanScanner({ query } satisfies SqlClient);
    const triples = await scanner.scan_orphans(50);
    expect(triples).toEqual([ingress_triple({ wamid: "wamid-scan-1", has_inbound_row: false })]);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, values] = query.mock.calls[0] as unknown as [string, readonly unknown[]];
    expect(sql).toContain("processed_messages");
    expect(sql).toContain("LIMIT $1");
    expect(values).toEqual([50]);
    expect(sql).not.toContain("message_text");
    expect(sql).not.toContain("phone");
  });

  it("rejects invalid limits before querying and wraps driver failures safely", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const scanner = new PostgresIngressOrphanScanner({ query } satisfies SqlClient);
    await expect(scanner.scan_orphans(0)).rejects.toBeInstanceOf(IngressReconciliationError);
    expect(query).not.toHaveBeenCalled();

    const failing = new PostgresIngressOrphanScanner({
      query: vi.fn(async () => {
        throw new Error("password=secret internal SQL");
      }),
    } satisfies SqlClient);
    const error = await failing.scan_orphans(10).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(IngressReconciliationError);
    expect(String(error)).not.toMatch(/secret|internal SQL/);
  });

  it("rejects malformed scan rows fail-closed", async () => {
    const scanner = new PostgresIngressOrphanScanner({
      query: vi.fn(async () => ({ rows: [{ tenant_id: 42 }], rowCount: 1 })),
    } satisfies SqlClient);
    await expect(scanner.scan_orphans(10)).rejects.toBeInstanceOf(IngressReconciliationError);
  });

  it("returns defensive copies from the in-memory scanner", async () => {
    const scanner = new InMemoryIngressOrphanScanner([ingress_triple()]);
    const first = await scanner.scan_orphans(10);
    first[0]!.wamid = "mutated";
    expect((await scanner.scan_orphans(10))[0]!.wamid).toBe("wamid-reconcile-1");
  });
});
