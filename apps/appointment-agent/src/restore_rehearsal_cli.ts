/** CLI for the read-only restore rehearsal against a production-like database. */

import "dotenv/config";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PgSqlClient, load_pg_config } from "./persistence/pg_client.js";
import { run_restore_rehearsal } from "./enterprise/restore_rehearsal.js";

const database_url = process.env["DATABASE_URL"] ?? process.env["TEST_DATABASE_URL"];
if (database_url === undefined || database_url.trim() === "") {
  console.error(JSON.stringify({ event: "restore_rehearsal_blocked", reason: "DATABASE_URL-required" }));
  process.exitCode = 2;
} else {
  const config = load_pg_config(process.env);
  const client = new PgSqlClient({ ...config, connection_string: database_url });
  const migrations_dir = process.env["RESTORE_REHEARSAL_MIGRATIONS_DIR"] ?? join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "packages",
    "db",
    "migrations",
  );
  try {
    const report = await run_restore_rehearsal(client, { migrations_dir });
    console.log(JSON.stringify({
      event: "restore_rehearsal_completed",
      passed: report.passed,
      migration_head: report.migration_head,
      steps: report.steps,
      dr_objectives: {
        rpo_minutes: process.env["DR_RPO_MINUTES"] ?? null,
        rto_minutes: process.env["DR_RTO_MINUTES"] ?? null,
        backup_reference: process.env["DR_BACKUP_REFERENCE"] ?? null,
      },
    }));
    if (!report.passed) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({
      event: "restore_rehearsal_failed",
      reason: error instanceof Error ? error.message : "unknown",
    }));
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}
