/** Period-scoped cost allocation and chargeback reporting requirements. */

import { ChargebackLine, CostModelError, InMemoryCostLedger } from "./cost_model.js";

/** Agreed billing window and currency for one chargeback report. */
export interface ChargebackPeriod {
  tenant_id: string;
  currency: string;
  period_start_iso: string;
  period_end_iso: string;
}

/** Chargeback report attributing every tracked location to a tenant. */
export interface ChargebackReport {
  tenant_id: string;
  currency: string;
  period_start_iso: string;
  period_end_iso: string;
  lines: readonly ChargebackLine[];
  total_micro: number;
}

/**
 * Build a chargeback report from ledger usage.
 *
 * The ledger is period-scoped by construction: it accumulates only what the
 * caller recorded since the period opened, so the report must be produced
 * before the next period's usage is recorded into the same ledger.
 *
 * @param ledger - Ledger holding the period's usage for this tenant.
 * @param period - Agreed billing window and reporting currency.
 * @returns Frozen report with per-location lines and a tenant total.
 */
export function build_chargeback_report(ledger: InMemoryCostLedger, period: ChargebackPeriod): ChargebackReport {
  const normalized = validate_period(period);
  const lines = ledger.chargeback_lines(normalized.tenant_id);
  return Object.freeze({
    tenant_id: normalized.tenant_id,
    currency: normalized.currency,
    period_start_iso: normalized.period_start_iso,
    period_end_iso: normalized.period_end_iso,
    lines,
    total_micro: lines.reduce((sum, line) => sum + line.total_micro, 0),
  });
}

/**
 * Validate a chargeback period.
 *
 * An empty or inverted window is rejected because a zero-length period would
 * attribute spend to an undefined interval during dispute resolution.
 */
function validate_period(value: unknown): ChargebackPeriod {
  if (typeof value !== "object" || value === null) throw new CostModelError("cost-period-invalid");
  const record = value as Record<string, unknown>;
  const period_start_iso = timestamp(record.period_start_iso, "cost-period-invalid");
  const period_end_iso = timestamp(record.period_end_iso, "cost-period-invalid");
  if (period_end_iso <= period_start_iso) throw new CostModelError("cost-period-invalid");
  return {
    tenant_id: tenant_id_value(record.tenant_id),
    currency: currency_value(record.currency),
    period_start_iso,
    period_end_iso,
  };
}

function tenant_id_value(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9]\d{0,18}$/.test(value)) throw new CostModelError("cost-period-invalid");
  return value;
}

function currency_value(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value)) throw new CostModelError("cost-period-invalid");
  return value;
}

function timestamp(value: unknown, reason: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new CostModelError(reason);
  return new Date(Date.parse(value)).toISOString();
}