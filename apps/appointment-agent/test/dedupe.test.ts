import { describe, expect, it } from "vitest";
import {
  DedupeStoreError,
  InMemoryMessageDedupe,
  InvalidWamidError,
  PostgresMessageDedupe,
} from "../src/ingress/dedupe.js";

describe("in_memory_message_dedupe", () => {
  it("test_first_claim_wins_and_retry_is_duplicate", async () => {
    const store = new InMemoryMessageDedupe();
    expect(await store.try_claim("wamid.test-1")).toBe(true);
    expect(await store.try_claim("wamid.test-1")).toBe(false);
    expect(await store.has_seen("wamid.test-1")).toBe(true);
  });

  it("test_unseen_wamid_is_not_seen", async () => {
    const store = new InMemoryMessageDedupe();
    expect(await store.has_seen("wamid.fresh")).toBe(false);
  });

  it("test_rejects_empty_and_oversized_wamid", async () => {
    const store = new InMemoryMessageDedupe();
    await expect(store.try_claim("")).rejects.toThrow(InvalidWamidError);
    await expect(store.has_seen("")).rejects.toThrow(InvalidWamidError);
    await expect(store.try_claim(`wamid.${"x".repeat(200)}`)).rejects.toThrow(InvalidWamidError);
  });
});

describe("postgres_message_dedupe", () => {
  it("test_stub_fails_loud_until_table_is_wired", async () => {
    const store = new PostgresMessageDedupe();
    await expect(store.try_claim("wamid.test-1")).rejects.toThrow(DedupeStoreError);
    await expect(store.has_seen("wamid.test-1")).rejects.toThrow(DedupeStoreError);
  });
});
