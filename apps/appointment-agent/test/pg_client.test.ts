import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  load_pg_config,
  PgClientError,
  PgSqlClient,
  type PgPoolLike,
} from "../src/persistence/pg_client.js";

const pool_constructor = vi.hoisted(() => vi.fn());
vi.mock("pg", () => ({
  Pool: class {
    constructor(options: Record<string, unknown>) {
      pool_constructor(options);
    }

    async query() {
      return { rows: [], rowCount: 0 };
    }

    async end() {
      return undefined;
    }
  },
}));

describe("PgSqlClient", () => {
  beforeEach(() => {
    pool_constructor.mockClear();
  });

  it("loads bounded environment settings", () => {
    expect(
      load_pg_config({
        DATABASE_URL: "postgres://test.invalid/app",
        PG_STATEMENT_TIMEOUT_MS: "2500",
        PG_CONNECTION_TIMEOUT_MS: "1500",
        PG_APPLICATION_NAME: "sela-test",
        PG_POOL_MAX: "4",
      }),
    ).toMatchObject({
      connection_string: "postgres://test.invalid/app",
      statement_timeout_ms: 2500,
      connection_timeout_ms: 1500,
      application_name: "sela-test",
      max_pool_size: 4,
    });
  });

  it("passes the bounded connection timeout to the pg Pool", async () => {
    const client = new PgSqlClient({
      connection_string: "postgres://test.invalid/app",
      connection_timeout_ms: 1_500,
    });

    expect(pool_constructor).toHaveBeenCalledWith(
      expect.objectContaining({ connectionTimeoutMillis: 1_500 }),
    );
    await client.close();
  });

  it("rejects connection timeout values outside the supported bound", () => {
    expect(() => load_pg_config({ PG_CONNECTION_TIMEOUT_MS: "0" })).toThrow(PgClientError);
    expect(() => load_pg_config({ PG_CONNECTION_TIMEOUT_MS: "120001" })).toThrow(PgClientError);
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
