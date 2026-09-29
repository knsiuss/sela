/** CLI for the read-only production database gate. */

import "dotenv/config";
import { PgSqlClient, load_pg_config } from "./persistence/pg_client.js";
import {
  DatabaseProductionGateError,
  run_database_production_gate,
  type DatabaseRecoveryEvidence,
} from "./persistence/production_gate.js";

const database_url = process.env["DATABASE_URL"];
if (database_url === undefined || database_url.trim() === "") {
  console.error(JSON.stringify({ event: "database_gate_blocked", reason: "DATABASE_URL-required" }));
  process.exitCode = 2;
} else {
  const config = load_pg_config(process.env);
  const client = new PgSqlClient({ ...config, connection_string: database_url });
  try {
    const report = await run_database_production_gate(client, {
      require_tls: process.env["DATABASE_GATE_REQUIRE_TLS"] !== "false",
      backup_evidence: evidence("DATABASE_BACKUP_VERIFIED_AT", "DATABASE_BACKUP_REFERENCE"),
      restore_evidence: evidence("DATABASE_RESTORE_TESTED_AT", "DATABASE_RESTORE_REFERENCE"),
      connection_timeout_ms: config.connection_timeout_ms,
      transaction_timeout_ms: config.transaction_timeout_ms,
      max_pool_size: config.max_pool_size,
    });
    console.log(JSON.stringify({ event: "database_gate_completed", passed: report.passed, checks: report.checks }));
    if (!report.passed) process.exitCode = 1;
  } catch (error) {
    const reason = error instanceof DatabaseProductionGateError ? "checks_failed" : "database_gate_query_failed";
    console.error(JSON.stringify({ event: "database_gate_failed", reason }));
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

function evidence(timestamp_name: string, reference_name: string): DatabaseRecoveryEvidence | undefined {
  const verified_at_iso = process.env[timestamp_name];
  const reference = process.env[reference_name];
  if (verified_at_iso === undefined || reference === undefined) return undefined;
  return { verified_at_iso, reference };
}
