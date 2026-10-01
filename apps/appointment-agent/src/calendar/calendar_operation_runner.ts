/** Transactional replay ledger for committed calendar operations. */

import { createHash } from "node:crypto";
import type {
  SqlQueryResult,
  SqlTransactionClient,
  TransactionalSqlClient,
} from "../persistence/sql_client.js";
import {
  AppointmentNotFoundError,
  AppointmentNotReschedulableError,
  AppointmentVersionConflictError,
  CalendarOperationConflictError,
  CalendarStoreError,
  HoldExpiredError,
  SlotUnavailableError,
} from "../tools/calendar.js";
import { parse_json, parse_calendar_operation_result, type CalendarOperationResult } from "./calendar_models.js";
import { INSERT_OPERATION_SQL, LOAD_OPERATION_SQL, LOCK_OPERATION_SQL } from "./postgres_calendar_sql.js";

/** Dependencies for one tenant's operation coordinator. */
export interface CalendarOperationRunnerOptions {
  sql_client: TransactionalSqlClient;
  tenant_id: string;
}

/** Serialize one operation key and resolve retries after ambiguous commits. */
export class CalendarOperationRunner {
  private readonly sql_client: TransactionalSqlClient;
  private readonly tenant_id: string;

  /** Create a runner over the committed database operation ledger. */
  constructor(options: CalendarOperationRunnerOptions) {
    this.sql_client = options.sql_client;
    this.tenant_id = options.tenant_id;
  }

  /**
   * Execute one calendar mutation and commit its replay result atomically.
   *
   * @param operation_type - Stable operation family.
   * @param operation_key - Tenant-scoped retry key.
   * @param request_fingerprint - Canonical hash of the complete request.
   * @param work - Transactional mutation that returns a bounded result.
   * @returns The newly committed or replayed result.
   */
  async run<T extends CalendarOperationResult>(
    operation_type: T["operation_type"],
    operation_key: string,
    request_fingerprint: string,
    work: (transaction: SqlTransactionClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.sql_client.with_transaction(async (transaction) => {
        await transaction.query(LOCK_OPERATION_SQL, [operation_lock_key(this.tenant_id, operation_key)]);
        const replay = await this.load(transaction, operation_type, operation_key, request_fingerprint);
        if (replay !== null) return replay as T;
        const result = await work(transaction);
        await require_row(transaction.query(INSERT_OPERATION_SQL, [
          this.tenant_id,
          operation_key,
          operation_type,
          request_fingerprint,
          JSON.stringify(result),
        ]), "calendar-operation-ledger-failed");
        return result;
      });
    } catch (error) {
      const replay = await this.resolve_commit(operation_type, operation_key, request_fingerprint, error);
      if (replay !== null) return replay as T;
      throw error;
    }
  }

  private async resolve_commit<T extends CalendarOperationResult>(
    operation_type: T["operation_type"],
    operation_key: string,
    request_fingerprint: string,
    original_error: unknown,
  ): Promise<T | null> {
    try {
      return await this.load(
        this.sql_client,
        operation_type,
        operation_key,
        request_fingerprint,
      ) as T | null;
    } catch (resolve_error) {
      if (is_domain_error(original_error)) throw original_error;
      throw new CalendarStoreError(
        "calendar-commit-reconciliation-failed",
        new AggregateError([original_error, resolve_error], "calendar-commit-reconciliation-failed"),
      );
    }
  }

  private async load(
    client: Pick<SqlTransactionClient, "query">,
    operation_type: CalendarOperationResult["operation_type"],
    operation_key: string,
    request_fingerprint: string,
  ): Promise<CalendarOperationResult | null> {
    const result = await client.query(LOAD_OPERATION_SQL, [this.tenant_id, operation_key]);
    if (!Array.isArray(result.rows)) throw new CalendarStoreError("calendar-operation-result-invalid");
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (typeof row !== "object" || row === null) throw new CalendarStoreError("calendar-operation-row-invalid");
    const record = row as Record<string, unknown>;
    if (record.operation_type !== operation_type || record.request_fingerprint !== request_fingerprint) {
      throw new CalendarOperationConflictError();
    }
    try {
      return parse_calendar_operation_result(operation_type, parse_json(record.result));
    } catch (error) {
      throw new CalendarStoreError("calendar-operation-result-invalid", error);
    }
  }
}

async function require_row(
  result: SqlQueryResult | Promise<SqlQueryResult>,
  reason: string,
): Promise<Record<string, unknown>> {
  const resolved = await result;
  if (!Array.isArray(resolved.rows) || resolved.rows.length === 0) throw new CalendarStoreError(reason);
  const row = resolved.rows[0];
  if (typeof row !== "object" || row === null) throw new CalendarStoreError(reason);
  return row as Record<string, unknown>;
}

function operation_lock_key(tenant_id: string, operation_key: string): string {
  return createHash("sha256")
    .update(JSON.stringify(["calendar-operation-v1", tenant_id, operation_key]))
    .digest("hex");
}

function is_domain_error(error: unknown): error is Error {
  return error instanceof CalendarOperationConflictError
    || error instanceof SlotUnavailableError
    || error instanceof HoldExpiredError
    || error instanceof AppointmentNotFoundError
    || error instanceof AppointmentVersionConflictError
    || error instanceof AppointmentNotReschedulableError;
}
