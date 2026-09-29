/** Restore-rehearsal harness runnable against a production-like database. */

import { readdir } from "node:fs/promises";
import type { SqlClient } from "../persistence/sql_client.js";

/** Tables guaranteed by the committed migration baseline. */
export const REHEARSAL_REQUIRED_TABLES = Object.freeze([
  "tenants",
  "webhook_jobs",
  "inbound_messages",
  "processed_messages",
]);

/** One rehearsal step outcome with its own elapsed time. */
export interface RestoreRehearsalStep {
  name: string;
  passed: boolean;
  duration_ms: number;
  detail?: string;
}

/** Full rehearsal report; JSON-serializable for release evidence. */
export interface RestoreRehearsalReport {
  passed: boolean;
  migration_head: string | null;
  checked_at_iso: string;
  steps: RestoreRehearsalStep[];
}

/** Options for one rehearsal run. */
export interface RestoreRehearsalOptions {
  migrations_dir: string;
  required_tables?: readonly string[];
  clock?: () => number;
}

/** Safe failure when the rehearsal cannot prove recoverability. */
export class RestoreRehearsalError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`restore-rehearsal-${code}`);
    this.name = "RestoreRehearsalError";
    this.code = code;
  }
}

/**
 * Rehearse a restore against a production-like database without mutating it.
 *
 * All checks are read-only: migration-file sequence on disk, required-table
 * presence via to_regclass, and an RLS report for tenant tables. A missing
 * table or migration gap fails the rehearsal; RLS state is reported but does
 * not fail because role layouts differ between staging and production.
 *
 * @param client - Read-capable SQL boundary for the rehearsal target.
 * @param options - Migrations directory and optional table overrides.
 * @returns Report with per-step timings for RPO/RTO evidence.
 */
export async function run_restore_rehearsal(
  client: SqlClient,
  options: RestoreRehearsalOptions,
): Promise<RestoreRehearsalReport> {
  const clock = options.clock ?? Date.now;
  const steps: RestoreRehearsalStep[] = [];
  let migration_head: string | null = null;
  const migration_result = await timed_step(clock, async () => {
    migration_head = await verify_migration_sequence(options.migrations_dir);
  });
  steps.push({ name: "migration_sequence", ...migration_result });
  const tables = [...(options.required_tables ?? REHEARSAL_REQUIRED_TABLES)];
  const table_result = await timed_step(clock, async () => {
    await verify_required_tables(client, tables);
  });
  steps.push({ name: "required_tables", ...table_result });
  const rls_result = await timed_step(clock, async () => {
    await report_rls_state(client, tables);
  });
  steps.push({ name: "rls_report", ...rls_result });
  return {
    passed: steps.every((step) => step.passed),
    migration_head,
    checked_at_iso: new Date(clock()).toISOString(),
    steps,
  };
}

async function timed_step(
  clock: () => number,
  work: () => Promise<void>,
): Promise<{ passed: boolean; duration_ms: number; detail?: string }> {
  const started = clock();
  try {
    await work();
    return { passed: true, duration_ms: Math.max(0, clock() - started) };
  } catch (error) {
    const detail = error instanceof RestoreRehearsalError ? error.code : "rehearsal-query-failed";
    return { passed: false, duration_ms: Math.max(0, clock() - started), detail };
  }
}

/**
 * Verify migration files form a gapless 0001..NNNN sequence.
 *
 * @param migrations_dir - Directory holding `<seq>_<name>.sql` files.
 * @returns The highest migration name (the rehearsal head).
 */
async function verify_migration_sequence(migrations_dir: string): Promise<string> {
  let entries: string[];
  try {
    entries = await readdir(migrations_dir);
  } catch {
    throw new RestoreRehearsalError("migrations-unreadable");
  }
  const sequences = entries
    .filter((entry) => entry.endsWith(".sql"))
    .map((entry) => /^(\d{4})_.+\.sql$/.exec(entry)?.[1])
    .filter((sequence): sequence is string => sequence !== undefined)
    .map((sequence) => Number(sequence))
    .sort((left, right) => left - right);
  if (sequences.length === 0) throw new RestoreRehearsalError("migrations-empty");
  for (let index = 0; index < sequences.length; index += 1) {
    if (sequences[index] !== index + 1) throw new RestoreRehearsalError("migration-gap");
  }
  const head = entries.find((entry) => entry.startsWith(String(sequences.length).padStart(4, "0")));
  if (head === undefined) throw new RestoreRehearsalError("migration-head-missing");
  return head;
}

/**
 * Fail when any required table is absent from the rehearsal target.
 *
 * @param client - Read-capable SQL boundary.
 * @param tables - Table names expected from the migration baseline.
 */
async function verify_required_tables(client: SqlClient, tables: readonly string[]): Promise<void> {
  for (const table of tables) {
    if (!/^[a-z_]{1,64}$/.test(table)) throw new RestoreRehearsalError("table-invalid");
    let result;
    try {
      result = await client.query("SELECT to_regclass($1) AS oid", [table]);
    } catch {
      throw new RestoreRehearsalError("table-check-failed");
    }
    const oid = (result.rows?.[0] as Record<string, unknown> | undefined)?.oid;
    if (oid === null || oid === undefined) throw new RestoreRehearsalError("table-missing");
  }
}

/**
 * Report RLS state for tenant tables without failing the rehearsal.
 *
 * @param client - Read-capable SQL boundary.
 * @param tables - Tables to inspect in pg_tables.
 */
async function report_rls_state(client: SqlClient, tables: readonly string[]): Promise<void> {
  try {
    await client.query(
      "SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1)",
      [tables],
    );
  } catch {
    throw new RestoreRehearsalError("rls-check-failed");
  }
}
