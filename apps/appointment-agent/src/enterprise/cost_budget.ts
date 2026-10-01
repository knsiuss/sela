/** Budget policies and spend alerts for WhatsApp, LLM, database, and telemetry. */

import {
  COST_CATEGORIES,
  CostCategory,
  CostModelError,
  TenantCostSummary,
} from "./cost_model.js";

/** Declared per-category budget and the ratio that raises an early warning. */
export interface BudgetPolicy {
  tenant_id: string;
  currency: string;
  category_limits_micro: Readonly<Record<CostCategory, number>>;
  warn_ratio: number;
}

/** One evaluated budget line. */
export interface BudgetEvaluation {
  /** Stable, low-cardinality identifier; carries no tenant or customer data. */
  alert_id: string;
  category: CostCategory;
  state: "ok" | "warning" | "exceeded";
  consumed_ratio: number;
  spent_micro: number;
  limit_micro: number;
  currency: string;
}

/**
 * Evaluate every approved category against its budget.
 *
 * A zero limit is treated as an immediate breach when any spend exists rather
 * than as "unlimited", so an unset budget can never silently absorb traffic.
 *
 * @param summary - Tenant spend resolved by the cost ledger.
 * @param policy - Declared limits and warning ratio for the same tenant.
 * @returns Frozen evaluation for every approved category, in stable order.
 */
export function evaluate_budget(summary: TenantCostSummary, policy: BudgetPolicy): readonly BudgetEvaluation[] {
  const normalized = validate_budget_policy(policy);
  if (normalized.tenant_id !== summary.tenant_id) throw new CostModelError("cost-budget-tenant-mismatch");
  return Object.freeze(
    COST_CATEGORIES.map((category) => {
      const limit_micro = normalized.category_limits_micro[category];
      const spent_micro = summary.by_category[category];
      const ratio = consumed_ratio(spent_micro, limit_micro);
      const state = state_for(ratio, normalized.warn_ratio);
      return Object.freeze({
        alert_id: `cost_budget_${category}_${state}`,
        category,
        state,
        consumed_ratio: ratio,
        spent_micro,
        limit_micro,
        currency: normalized.currency,
      });
    }),
  );
}

function consumed_ratio(spent_micro: number, limit_micro: number): number {
  if (limit_micro > 0) return spent_micro / limit_micro;
  return spent_micro > 0 ? 1 : 0;
}

function state_for(ratio: number, warn_ratio: number): "ok" | "warning" | "exceeded" {
  if (ratio >= 1) return "exceeded";
  if (ratio >= warn_ratio) return "warning";
  return "ok";
}

function validate_budget_policy(value: unknown): BudgetPolicy {
  if (typeof value !== "object" || value === null) throw new CostModelError("cost-budget-invalid");
  const record = value as Record<string, unknown>;
  const raw_limits = record.category_limits_micro;
  if (typeof raw_limits !== "object" || raw_limits === null) throw new CostModelError("cost-budget-limit-invalid");
  const limits = raw_limits as Record<string, unknown>;
  const category_limits = {} as Record<CostCategory, number>;
  for (const category of COST_CATEGORIES) {
    category_limits[category] = non_negative_integer(limits[category], "cost-budget-limit-invalid");
  }
  return Object.freeze({
    tenant_id: tenant_id_value(record.tenant_id),
    currency: currency_value(record.currency),
    category_limits_micro: Object.freeze(category_limits),
    warn_ratio: warn_ratio(record.warn_ratio),
  });
}

function tenant_id_value(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9]\d{0,18}$/.test(value)) throw new CostModelError("cost-budget-tenant-invalid");
  return value;
}

function currency_value(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value)) throw new CostModelError("cost-currency-invalid");
  return value;
}

function warn_ratio(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new CostModelError("cost-warn-ratio-invalid");
  }
  return value;
}

function non_negative_integer(value: unknown, reason: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new CostModelError(reason);
  return value;
}