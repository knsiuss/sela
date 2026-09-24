import { describe, expect, it, vi } from "vitest";
import {
  DedupeStoreError,
  InMemoryMessageDedupe,
  InvalidTenantIdError,
  InvalidWamidError,
  PostgresMessageDedupe,
} from "../src/ingress/dedupe.js";
import type { SqlClient } from "../src/ingress/postgres_dedupe.js";

const TENANT_ID = "42";
const OTHER_TENANT_ID = "43";
const WAMID = "wamid.test-1";

describe("in_memory_message_dedupe", () => {
  it("claims a tenant/message pair once and allows the same wamid in another tenant", async () => {
    const store = new InMemoryMessageDedupe();

    expect(await store.try_claim(TENANT_ID, WAMID)).toBe(true);
    expect(await store.try_claim(TENANT_ID, WAMID)).toBe(false);
    expect(await store.has_seen(TENANT_ID, WAMID)).toBe(true);
    expect(await store.try_claim(OTHER_TENANT_ID, WAMID)).toBe(true);
    expect(await store.has_seen(OTHER_TENANT_ID, WAMID)).toBe(true);
  });

  it("releases only the requested tenant/message claim", async () => {
    const store = new InMemoryMessageDedupe();
    await store.try_claim(TENANT_ID, WAMID);
    await store.try_claim(OTHER_TENANT_ID, WAMID);

    await store.release_claim(TENANT_ID, WAMID);

    expect(await store.has_seen(TENANT_ID, WAMID)).toBe(false);
    expect(await store.has_seen(OTHER_TENANT_ID, WAMID)).toBe(true);
    expect(await store.try_claim(TENANT_ID, WAMID)).toBe(true);
  });

  it("rejects missing tenant ids and invalid wamids before accessing state", async () => {
    const store = new InMemoryMessageDedupe();

    await expect(store.try_claim("", WAMID)).rejects.toThrow(InvalidTenantIdError);
    await expect(store.has_seen("t".repeat(257), WAMID)).rejects.toThrow(InvalidTenantIdError);
    await expect(store.has_seen(TENANT_ID, "")).rejects.toThrow(InvalidWamidError);
    await expect(store.release_claim(TENANT_ID, `wamid.${"x".repeat(200)}`)).rejects.toThrow(
      InvalidWamidError,
    );
  });
});

describe("postgres_message_dedupe", () => {
  it("claims once, scopes by tenant, and allows a claim after release", async () => {
    const claimed_keys = new Set<string>();
    const query = async (sql: string, values?: readonly unknown[]) => {
      const key = `${String(values?.[0])}\u0000${String(values?.[1])}`;
      if (sql.includes("INSERT INTO processed_messages")) {
        if (claimed_keys.has(key)) return { rows: [] };
        claimed_keys.add(key);
        return { rows: [{ tenant_id: values?.[0], wamid: values?.[1] }] };
      }
      if (sql.includes("DELETE FROM processed_messages")) {
        claimed_keys.delete(key);
        return { rows: [] };
      }
      return { rows: claimed_keys.has(key) ? [{ tenant_id: values?.[0], wamid: values?.[1] }] : [] };
    };
    const client = { query: vi.fn(query) };
    const store = new PostgresMessageDedupe(client);

    expect(await store.try_claim(TENANT_ID, WAMID)).toBe(true);
    expect(await store.try_claim(TENANT_ID, WAMID)).toBe(false);
    expect(await store.has_seen(TENANT_ID, WAMID)).toBe(true);
    expect(await store.try_claim(OTHER_TENANT_ID, WAMID)).toBe(true);

    await store.release_claim(TENANT_ID, WAMID);

    expect(await store.has_seen(TENANT_ID, WAMID)).toBe(false);
    expect(await store.has_seen(OTHER_TENANT_ID, WAMID)).toBe(true);
    expect(await store.try_claim(TENANT_ID, WAMID)).toBe(true);
  });

  it("uses the composite conflict and bound tenant/message values", async () => {
    const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({
      rows: [{ tenant_id: TENANT_ID, wamid: WAMID }],
      rowCount: 1,
    }));
    const store = new PostgresMessageDedupe({ query });

    await expect(store.try_claim(TENANT_ID, WAMID)).resolves.toBe(true);
    await expect(store.has_seen(TENANT_ID, WAMID)).resolves.toBe(true);
    await store.release_claim(TENANT_ID, WAMID);

    expect(query.mock.calls[0]?.[0]).toContain("ON CONFLICT (tenant_id, wamid) DO NOTHING");
    expect(query.mock.calls[1]?.[0]).toContain("WHERE tenant_id = $1 AND wamid = $2");
    expect(query.mock.calls[2]?.[0]).toContain("WHERE tenant_id = $1 AND wamid = $2");
    for (const call of query.mock.calls) {
      expect(call[1]).toEqual([TENANT_ID, WAMID]);
    }
  });

  it("supports a row-count-only SQL client and rejects unexpected unique violations", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 0 });
    const store = new PostgresMessageDedupe({ query } satisfies SqlClient);
    expect(await store.try_claim(TENANT_ID, "wamid.row-count")).toBe(true);
    expect(await store.try_claim(TENANT_ID, "wamid.row-count")).toBe(false);

    const conflict_query = vi.fn().mockRejectedValue({ code: "23505", constraint: "processed_messages_wamid_key" });
    const conflict_store = new PostgresMessageDedupe({ query: conflict_query } satisfies SqlClient);
    await expect(conflict_store.try_claim(TENANT_ID, "wamid.conflict")).rejects.toMatchObject({
      name: "DedupeStoreError",
      message: "postgres-dedupe-query-failed",
    });
  });

  it("fails closed when a release result has no verifiable metadata", async () => {
    const store = new PostgresMessageDedupe({ query: vi.fn(async () => ({})) } satisfies SqlClient);
    await expect(store.release_claim(TENANT_ID, "wamid.invalid-result")).rejects.toMatchObject({
      name: "DedupeStoreError",
    });
  });

  it("rejects invalid identity before issuing SQL", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const store = new PostgresMessageDedupe({ query });

    await expect(store.try_claim("", WAMID)).rejects.toThrow(InvalidTenantIdError);
    await expect(store.has_seen(TENANT_ID, "")).rejects.toThrow(InvalidWamidError);
    expect(query).not.toHaveBeenCalled();
  });

  it("fails loud when the SQL client is missing", async () => {
    const store = new PostgresMessageDedupe();
    await expect(store.try_claim(TENANT_ID, WAMID)).rejects.toThrow(DedupeStoreError);
    await expect(store.has_seen(TENANT_ID, WAMID)).rejects.toThrow(DedupeStoreError);
    await expect(store.release_claim(TENANT_ID, WAMID)).rejects.toThrow(DedupeStoreError);
  });
});
