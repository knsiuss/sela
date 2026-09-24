import { describe, expect, it, vi } from "vitest";
import {
  load_pg_config,
  PgClientError,
  PgSqlClient,
  type PgPoolLike,
} from "../src/persistence/pg_client.js";

describe("PgSqlClient", () => {
  it("loads bounded environment settings", () => {
    expect(
      load_pg_config({
        DATABASE_URL: "postgres://test.invalid/app",
        PG_STATEMENT_TIMEOUT_MS: "2500",
        PG_APPLICATION_NAME: "sela-test",
        PG_POOL_MAX: "4",
      }),
    ).toMatchObject({
      connection_string: "postgres://test.invalid/app",
      statement_timeout_ms: 2500,
      application_name: "sela-test",
      max_pool_size: 4,
    });
  });

  it("delegates parameterized queries and closes the pool once", async () => {
    const query = vi.fn(async () => ({ rows: [{ ok: true }], rowCount: 1 }));
    const end = vi.fn(async () => undefined);
    const pool: PgPoolLike = { query, end };
    const client = new PgSqlClient({ pool });

    await expect(client.query("SELECT $1", ["value"])).resolves.toEqual({
      rows: [{ ok: true }],
      rowCount: 1,
    });
    await client.close();
    await client.close();

    expect(query).toHaveBeenCalledWith("SELECT $1", ["value"]);
    expect(end).toHaveBeenCalledTimes(1);
    await expect(client.query("SELECT 1")).rejects.toBeInstanceOf(PgClientError);
  });

  it("does not expose a driver error message", async () => {
    const pool: PgPoolLike = {
      query: vi.fn(async () => {
        throw new Error("password=secret and internal SQL");
      }),
      end: vi.fn(async () => undefined),
    };
    const client = new PgSqlClient({ pool });

    await expect(client.query("SELECT 1")).rejects.toBeInstanceOf(PgClientError);
    await expect(client.query("SELECT 1")).rejects.not.toThrow("password=secret");
  });
});
