import { describe, expect, it, vi } from "vitest";
import { claim_next_job, JobClaimError } from "../src/worker/job_claim.js";
import type { SqlClient } from "../src/persistence/sql_client.js";

const ROW = {
  id: "17",
  tenant_id: "42",
  request_id: "request-17",
  wamid: "wamid.claim-17",
  conversation_id: "conversation-17",
  received_at_iso: "2026-09-24T08:00:00.000Z",
  attempts: 1,
  claim_token: "claim-token-17",
};

describe("claim_next_job", () => {
  it("claims with SKIP LOCKED and returns normalized job fields", async () => {
    const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows: [ROW], rowCount: 1 }));
    const client = { query } satisfies SqlClient;

    await expect(claim_next_job(client, "42")).resolves.toMatchObject({
      id: "17",
      tenant_id: "42",
      wamid: ROW.wamid,
      attempts: 1,
      claim_token: ROW.claim_token,
    });
    const [sql, values] = query.mock.calls[0] ?? [];
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(sql).toContain("status = 'claimed'");
    expect(sql).toContain("claim_token = gen_random_uuid()::text");
    expect(sql).toContain("claimed_at < now() - interval '5 minutes'");
    expect(sql).toContain("attempts = attempts + 1");
    expect(values).toEqual(["42"]);
  });

  it("reclaims stale claimed jobs with a fresh fencing token", async () => {
    const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({
      rows: [{ ...ROW, attempts: 2, claim_token: "claim-token-reclaimed" }],
      rowCount: 1,
    }));
    const client = { query } satisfies SqlClient;

    await expect(claim_next_job(client)).resolves.toMatchObject({
      attempts: 2,
      claim_token: "claim-token-reclaimed",
    });
    const [sql] = query.mock.calls[0] ?? [];
    expect(sql).toContain("status = 'claimed'");
    expect(sql).toContain("claimed_at IS NULL OR claimed_at < now() - interval '5 minutes'");
    expect(sql).toContain("claim_token = gen_random_uuid()::text");
  });

  it("rejects a claimed row without a fencing token", async () => {
    const query = vi.fn(async () => ({
      rows: [{ ...ROW, claim_token: undefined }],
      rowCount: 1,
    }));

    await expect(claim_next_job({ query } satisfies SqlClient)).rejects.toBeInstanceOf(JobClaimError);
  });

  it("returns null when the queue has no pending row", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    await expect(claim_next_job({ query } satisfies SqlClient)).resolves.toBeNull();
  });

  it("translates a query failure without exposing driver details", async () => {
    const query = vi.fn(async () => {
      throw new Error("password=secret and SQL text");
    });

    await expect(claim_next_job({ query } satisfies SqlClient)).rejects.toBeInstanceOf(JobClaimError);
    await expect(claim_next_job({ query } satisfies SqlClient)).rejects.not.toThrow("password=secret");
  });
});
