import { describe, expect, it } from "vitest";
import { COST_CATEGORIES, CostModelError, InMemoryCostLedger } from "../src/enterprise/cost_model.js";

const RATES = {
  whatsapp_message: 25,
  llm_call: 1_500,
  database_operation: 40,
  observability_event: 2,
};

function seeded_ledger(): InMemoryCostLedger {
  const ledger = new InMemoryCostLedger(RATES);
  ledger.record({ tenant_id: "42", location_id: "clinic-1", category: "whatsapp_message", units: 100 });
  ledger.record({ tenant_id: "42", location_id: "clinic-1", category: "llm_call", units: 4 });
  ledger.record({ tenant_id: "42", location_id: "clinic-2", category: "whatsapp_message", units: 10 });
  ledger.record_outcome("42", "clinic-1", 10, 100);
  return ledger;
}

describe("cost ledger accounting", () => {
  it("derives total spend and per-category breakdown in micro-units", () => {
    const summary = seeded_ledger().summarize("42");
    expect(summary.total_micro).toBe(8_750);
    expect(summary.by_category.whatsapp_message).toBe(2_750);
    expect(summary.by_category.llm_call).toBe(6_000);
    expect(Object.isFrozen(summary)).toBe(true);
  });

  it("derives cost per appointment and cost per message", () => {
    const summary = seeded_ledger().summarize("42");
    expect(summary.cost_per_appointment_micro).toBe(875);
    expect(summary.cost_per_message_micro).toBe(87.5);
  });

  it("reports per-unit cost as not computable instead of dividing by zero", () => {
    const ledger = new InMemoryCostLedger(RATES);
    ledger.record({ tenant_id: "42", location_id: "clinic-1", category: "llm_call", units: 3 });
    const summary = ledger.summarize("42");
    expect(summary.cost_per_appointment_micro).toBeNull();
    expect(summary.cost_per_message_micro).toBeNull();
    expect(Number.isFinite(summary.total_micro)).toBe(true);
  });

  it("keeps tenants isolated in the aggregated summary", () => {
    const ledger = seeded_ledger();
    ledger.record({ tenant_id: "43", location_id: "clinic-1", category: "llm_call", units: 100 });
    expect(ledger.summarize("42").total_micro).toBe(8_750);
    expect(ledger.summarize("43").total_micro).toBe(150_000);
  });

  it("accumulates repeated usage entries for one location", () => {
    const ledger = new InMemoryCostLedger(RATES);
    ledger.record({ tenant_id: "42", location_id: "clinic-1", category: "llm_call", units: 2 });
    ledger.record({ tenant_id: "42", location_id: "clinic-1", category: "llm_call", units: 3 });
    expect(ledger.summarize("42").by_category.llm_call).toBe(7_500);
  });

  it("resolves per-location chargeback lines and their tenant total", () => {
    const lines = seeded_ledger().chargeback_lines("42");
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => line.location_id).sort()).toEqual(["clinic-1", "clinic-2"]);
    expect(lines.find((line) => line.location_id === "clinic-1")?.total_micro).toBe(8_500);
  });

  it("fails loudly when tracked-location capacity is exhausted", () => {
    const ledger = new InMemoryCostLedger(RATES);
    for (let index = 0; index < 10_000; index += 1) {
      ledger.record({ tenant_id: "42", location_id: `loc-${index}`, category: "llm_call", units: 1 });
    }
    expect(() => ledger.record({ tenant_id: "42", location_id: "one-too-many", category: "llm_call", units: 1 }))
      .toThrow(CostModelError);
    expect(ledger.summarize("42").by_category.llm_call).toBe(10_000 * 1_500);
  });
});

describe("cost ledger validation", () => {
  it("accepts zero-cost categories without treating them as invalid", () => {
    const ledger = new InMemoryCostLedger({ ...RATES, observability_event: 0 });
    ledger.record({ tenant_id: "42", location_id: "clinic-1", category: "observability_event", units: 5 });
    expect(ledger.summarize("42").by_category.observability_event).toBe(0);
  });

  it.each([
    ["negative rate", { ...RATES, llm_call: -1 }],
    ["fractional rate", { ...RATES, llm_call: 1.5 }],
    ["missing rate", { whatsapp_message: 1, llm_call: 1, database_operation: 1 }],
  ])("rejects a %s", (_label, value) => {
    expect(() => new InMemoryCostLedger(value as never)).toThrow(CostModelError);
  });

  it.each([
    ["unknown category", { tenant_id: "42", location_id: "clinic-1", category: "gpu_hour", units: 1 }],
    ["zero units", { tenant_id: "42", location_id: "clinic-1", category: "llm_call", units: 0 }],
    ["non-numeric tenant", { tenant_id: "clinic", location_id: "clinic-1", category: "llm_call", units: 1 }],
    ["empty location", { tenant_id: "42", location_id: "", category: "llm_call", units: 1 }],
  ])("rejects %s", (_label, value) => {
    const ledger = new InMemoryCostLedger(RATES);
    expect(() => ledger.record(value as never)).toThrow(CostModelError);
  });

  it("rejects a negative outcome denominator", () => {
    const ledger = new InMemoryCostLedger(RATES);
    expect(() => ledger.record_outcome("42", "clinic-1", -1, 1)).toThrow(CostModelError);
  });

  it("refuses usage counts that would lose integer precision when priced", () => {
    const ledger = new InMemoryCostLedger(RATES);
    expect(() => ledger.record({
      tenant_id: "42",
      location_id: "clinic-1",
      category: "llm_call",
      units: Number.MAX_SAFE_INTEGER,
    })).toThrow(CostModelError);
  });

  it("refuses a rate that would overflow an exact micro-unit total", () => {
    expect(() => new InMemoryCostLedger({ ...RATES, llm_call: Number.MAX_SAFE_INTEGER })).toThrow(CostModelError);
  });

  it("rejects a control character in a location identifier", () => {
    const ledger = new InMemoryCostLedger(RATES);
    const injected = String.fromCharCode(0);
    expect(() => ledger.record({
      tenant_id: "42",
      location_id: `clinic${injected}`,
      category: "llm_call",
      units: 1,
    })).toThrow(CostModelError);
  });

  it("keeps the approved category set closed", () => {
    expect(COST_CATEGORIES).toEqual([
      "whatsapp_message",
      "llm_call",
      "database_operation",
      "observability_event",
    ]);
  });
});