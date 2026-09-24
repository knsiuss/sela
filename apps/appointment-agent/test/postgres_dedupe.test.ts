import { describe, expect, it, vi } from "vitest";
import {
  PostgresMessageDedupe,
  type SqlClient,
} from "../src/ingress/postgres_dedupe.js";

describe("postgres_message_dedupe", () => {
  it("claims_once_then_allows_a_claim_after_release", async () => {
    const claimed_wamids = new Set<string>();
    const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
      const wamid = String(values?.[0]);
      if (sql.includes("INSERT INTO processed_messages")) {
        if (claimed_wamids.has(wamid)) return { rows: [] };
        claimed_wamids.add(wamid);
        return { rows: [{ wamid }] };
      }
      if (sql.includes("DELETE FROM processed_messages")) {
        claimed_wamids.delete(wamid);
        return { rows: [] };
      }
      return { rows: claimed_wamids.has(wamid) ? [{ wamid }] : [] };
    });
    const client: SqlClient = { query };
    const store = new PostgresMessageDedupe(client);

    expect(await store.try_claim("wamid.test-1")).toBe(true);
    expect(await store.try_claim("wamid.test-1")).toBe(false);
    expect(await store.has_seen("wamid.test-1")).toBe(true);

    await store.release_claim("wamid.test-1");

    expect(await store.has_seen("wamid.test-1")).toBe(false);
    expect(await store.try_claim("wamid.test-1")).toBe(true);
  });

  it("supports a row-count-only SQL client and maps a unique conflict to duplicate", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 0 });
    const store = new PostgresMessageDedupe({ query } satisfies SqlClient);
    expect(await store.try_claim("wamid.row-count")).toBe(true);
    expect(await store.try_claim("wamid.row-count")).toBe(false);

    const conflict_query = vi.fn().mockRejectedValue({ code: "23505" });
    const conflict_store = new PostgresMessageDedupe({ query: conflict_query } satisfies SqlClient);
    expect(await conflict_store.try_claim("wamid.conflict")).toBe(false);
  });
});
