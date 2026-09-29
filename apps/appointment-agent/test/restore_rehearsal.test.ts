import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SqlClient } from "../src/persistence/sql_client.js";
import { run_restore_rehearsal } from "../src/enterprise/restore_rehearsal.js";

const created_dirs: string[] = [];

afterEach(() => {
  while (created_dirs.length > 0) rmSync(created_dirs.pop()!, { recursive: true, force: true });
});

function migrations_dir(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "rehearsal-"));
  created_dirs.push(dir);
  for (const file of files) writeFileSync(join(dir, file), "-- fixture");
  return dir;
}

function present_client(): SqlClient {
  return {
    query: async (sql) => {
      if (sql.includes("to_regclass")) return { rows: [{ oid: 12345 }] };
      return { rows: [{ tablename: "tenants", rowsecurity: true }] };
    },
  };
}

describe("restore rehearsal", () => {
  it("passes against a healthy production-like target", async () => {
    const report = await run_restore_rehearsal(present_client(), {
      migrations_dir: migrations_dir(["0001_init.sql", "0002_rls.sql", "0003_rag.sql"]),
    });
    expect(report.passed).toBe(true);
    expect(report.migration_head).toBe("0003_rag.sql");
    expect(report.steps.map((step) => step.name)).toEqual(["migration_sequence", "required_tables", "rls_report"]);
    expect(report.steps.every((step) => step.duration_ms >= 0)).toBe(true);
  });

  it("fails closed on a migration gap", async () => {
    const report = await run_restore_rehearsal(present_client(), {
      migrations_dir: migrations_dir(["0001_init.sql", "0003_rag.sql"]),
    });
    expect(report.passed).toBe(false);
    expect(report.steps[0]?.passed).toBe(false);
    expect(report.steps[0]?.detail).toBe("migration-gap");
  });

  it("fails closed when a required table is missing", async () => {
    const missing: SqlClient = {
      query: async (sql) => {
        if (sql.includes("to_regclass")) return { rows: [{ oid: null }] };
        return { rows: [] };
      },
    };
    const report = await run_restore_rehearsal(missing, {
      migrations_dir: migrations_dir(["0001_init.sql"]),
    });
    expect(report.passed).toBe(false);
    expect(report.steps[1]).toMatchObject({ name: "required_tables", passed: false, detail: "table-missing" });
  });

  it("fails closed when the database is unreachable", async () => {
    const down: SqlClient = {
      query: async () => {
        throw new Error("connection refused");
      },
    };
    const report = await run_restore_rehearsal(down, {
      migrations_dir: migrations_dir(["0001_init.sql"]),
    });
    expect(report.passed).toBe(false);
    expect(report.steps[1]?.detail).toBe("table-check-failed");
  });
});
