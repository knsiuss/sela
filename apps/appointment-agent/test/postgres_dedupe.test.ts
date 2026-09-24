import { describe, expect, it, vi } from "vitest";
import {
  PostgresMessageDedupe,
  type SqlClient,
} from "../src/ingress/postgres_dedupe.js";

describe("postgres_message_dedupe", () => {
  it("claims_once_then_allows_a_claim_after_release", async () => {
    const claimed_keys = new Set<string>();
    const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
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
    });
    const client: SqlClient = { query };
    const store = new PostgresMessageDedupe(client);

    expect(await store.try_claim("42", "wamid.test-1")).toBe(true);
    expect(await store.try_claim("42", "wamid.test-1")).toBe(false);
    expect(await store.has_seen("42", "wamid.test-1")).toBe(true);
    expect(await store.try_claim("43", "wamid.test-1")).toBe(true);

    await store.release_claim("42", "wamid.test-1");

    expect(await store.has_seen("42", "wamid.test-1")).toBe(false);
    expect(await store.has_seen("43", "wamid.test-1")).toBe(true);
    expect(await store.try_claim("42", "wamid.test-1")).toBe(true);
  });

  it("supports a row-count-only SQL client and maps a unique conflict to duplicate", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 0 });
    const store = new PostgresMessageDedupe({ query } satisfies SqlClient);
    expect(await store.try_claim("42", "wamid.row-count")).toBe(true);
    expect(await store.try_claim("42", "wamid.row-count")).toBe(false);

    const conflict_query = vi.fn().mockRejectedValue({ code: "23505" });
    const conflict_store = new PostgresMessageDedupe({ query: conflict_query } satisfies SqlClient);
    expect(await conflict_store.try_claim("42", "wamid.conflict")).toBe(false);
  });

  it("fails closed when a release result has no verifiable metadata", async () => {
    const store = new PostgresMessageDedupe({ query: vi.fn(async () => ({})) } satisfies SqlClient);
    await expect(store.release_claim("42", "wamid.invalid-result")).rejects.toMatchObject({
      name: "DedupeStoreError",
    });
  });
});
