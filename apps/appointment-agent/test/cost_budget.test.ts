import { describe, expect, it } from "vitest";
import { evaluate_budget } from "../src/enterprise/cost_budget.js";
import { CostModelError, InMemoryCostLedger } from "../src/enterprise/cost_model.js";

const ZERO_LIMITS = {
  whatsapp_message: 0,
  llm_call: 0,
  database_operation: 0,
  observability_event: 0,
};

function ledger_with_usage(): InMemoryCostLedger {
  const ledger = new InMemoryCostLedger({
    whatsapp_message: 25,
    llm_call: 1_500,
    database_operation: 40,
    observability_event: 2,
  });
  ledger.record({ tenant_id: "42", location_id: "clinic-1", category: "whatsapp_message", units: 100 });
  ledger.record({ tenant_id: "42", location_id: "clinic-1", category: "llm_call", units: 4 });
  return ledger;
}

function evaluation_by_category(category: string): ReturnType<typeof evaluate_budget>[number] {
  const summary = ledger_with_usage().summarize("42");
  return evaluate_budget(summary, {
    tenant_id: "42",
    currency: "USD",
    category_limits_micro: {
      whatsapp_message: 2_000,
      llm_call: 10_000,
      database_operation: 0,
      observability_event: 0,
    },
    warn_ratio: 0.8,
  }).find((evaluation) => evaluation.category === category)!;
}

describe("budget evaluation", () => {
  it("raises an exceeded alert when spend passes the category limit", () => {
    expect(evaluation_by_category("whatsapp_message")).toMatchObject({
      state: "exceeded",
      consumed_ratio: 1.25,
      limit_micro: 2_000,
      currency: "USD",
    });
  });

  it("stays ok while spend remains below the warning ratio", () => {
    expect(evaluation_by_category("llm_call")).toMatchObject({ state: "ok", consumed_ratio: 0.6 });
  });

  it("treats a zero limit with any spend as an immediate breach", () => {
    const summary = new InMemoryCostLedger({ whatsapp_message: 25, llm_call: 1_500, database_operation: 40, observability_event: 2 });
    summary.record({ tenant_id: "42", location_id: "clinic-1", category: "database_operation", units: 1 });
    const evaluation = evaluate_budget(summary.summarize("42"), {
      tenant_id: "42",
      currency: "USD",
      category_limits_micro: ZERO_LIMITS,
      warn_ratio: 0.8,
    }).find((entry) => entry.category === "database_operation")!;
    expect(evaluation).toMatchObject({ state: "exceeded", consumed_ratio: 1 });
  });

  it("evaluates every approved category in stable order", () => {
    const evaluations = evaluate_budget(ledger_with_usage().summarize("42"), {
      tenant_id: "42",
      currency: "USD",
      category_limits_micro: ZERO_LIMITS,
      warn_ratio: 0.8,
    });
    expect(evaluations.map((entry) => entry.category)).toEqual([
      "whatsapp_message",
      "llm_call",
      "database_operation",
      "observability_event",
    ]);
  });

  it("emits stable low-cardinality alert identifiers without tenant data", () => {
    const evaluation = evaluation_by_category("whatsapp_message");
    expect(evaluation.alert_id).toBe("cost_budget_whatsapp_message_exceeded");
    expect(evaluation.alert_id).not.toContain("42");
    expect(Object.isFrozen(evaluation)).toBe(true);
  });

  it("refuses to compare a budget against a different tenant summary", () => {
    expect(() => evaluate_budget(ledger_with_usage().summarize("42"), {
      tenant_id: "43",
      currency: "USD",
      category_limits_micro: ZERO_LIMITS,
      warn_ratio: 0.8,
    })).toThrow(CostModelError);
  });

  it.each([
    ["non-object policy", "invalid"],
    ["lowercase currency", { tenant_id: "42", currency: "usd", category_limits_micro: ZERO_LIMITS, warn_ratio: 0.8 }],
    ["warn ratio above one", { tenant_id: "42", currency: "USD", category_limits_micro: ZERO_LIMITS, warn_ratio: 1.5 }],
    ["zero warn ratio", { tenant_id: "42", currency: "USD", category_limits_micro: ZERO_LIMITS, warn_ratio: 0 }],
    ["negative limit", {
      tenant_id: "42",
      currency: "USD",
      category_limits_micro: { ...ZERO_LIMITS, llm_call: -1 },
      warn_ratio: 0.8,
    }],
    ["missing limit", { tenant_id: "42", currency: "USD", category_limits_micro: {}, warn_ratio: 0.8 }],
  ])("rejects %s", (_label, policy) => {
    if (policy === "invalid") {
      expect(() => evaluate_budget(ledger_with_usage().summarize("42"), "invalid" as never)).toThrow(CostModelError);
      return;
    }
    expect(() => evaluate_budget(ledger_with_usage().summarize("42"), policy as never)).toThrow(CostModelError);
  });
});