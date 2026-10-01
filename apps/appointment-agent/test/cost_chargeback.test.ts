import { describe, expect, it } from "vitest";
import { build_chargeback_report } from "../src/enterprise/cost_chargeback.js";
import { CostModelError, InMemoryCostLedger } from "../src/enterprise/cost_model.js";

const PERIOD = {
  tenant_id: "42",
  currency: "USD",
  period_start_iso: "2026-09-01T00:00:00.000Z",
  period_end_iso: "2026-10-01T00:00:00.000Z",
};

function ledger_with_two_locations(): InMemoryCostLedger {
  const ledger = new InMemoryCostLedger({
    whatsapp_message: 25,
    llm_call: 1_500,
    database_operation: 40,
    observability_event: 2,
  });
  ledger.record({ tenant_id: "42", location_id: "clinic-1", category: "whatsapp_message", units: 100 });
  ledger.record({ tenant_id: "42", location_id: "clinic-1", category: "llm_call", units: 2 });
  ledger.record({ tenant_id: "42", location_id: "clinic-2", category: "whatsapp_message", units: 10 });
  return ledger;
}

describe("chargeback reporting", () => {
  it("attributes spend per location and totals it for the tenant", () => {
    const report = build_chargeback_report(ledger_with_two_locations(), PERIOD);
    expect(report.lines).toHaveLength(2);
    expect(report.total_micro).toBe(5_750);
    expect(report).toMatchObject({ tenant_id: "42", currency: "USD" });
  });

  it("normalizes the reporting window to UTC timestamps", () => {
    const report = build_chargeback_report(ledger_with_two_locations(), {
      ...PERIOD,
      period_start_iso: "2026-09-01T07:00:00+07:00",
    });
    expect(report.period_start_iso).toBe("2026-09-01T00:00:00.000Z");
  });

  it("excludes another tenant's locations from the report", () => {
    const ledger = ledger_with_two_locations();
    ledger.record({ tenant_id: "43", location_id: "clinic-9", category: "llm_call", units: 50 });
    const report = build_chargeback_report(ledger, PERIOD);
    expect(report.lines.map((line) => line.location_id).sort()).toEqual(["clinic-1", "clinic-2"]);
    expect(report.total_micro).toBe(5_750);
  });

  it("returns an empty report for a tenant with no recorded usage", () => {
    const report = build_chargeback_report(ledger_with_two_locations(), { ...PERIOD, tenant_id: "44" });
    expect(report.lines).toEqual([]);
    expect(report.total_micro).toBe(0);
  });

  it.each([
    ["inverted window", { ...PERIOD, period_start_iso: "2026-10-01T00:00:00.000Z" }],
    ["zero-length window", {
      ...PERIOD,
      period_start_iso: "2026-10-01T00:00:00.000Z",
      period_end_iso: "2026-10-01T00:00:00.000Z",
    }],
    ["unparseable window", { ...PERIOD, period_end_iso: "not-a-date" }],
    ["non-numeric tenant", { ...PERIOD, tenant_id: "clinic" }],
    ["lowercase currency", { ...PERIOD, currency: "usd" }],
  ])("rejects a %s", (_label, period) => {
    expect(() => build_chargeback_report(ledger_with_two_locations(), period as never)).toThrow(CostModelError);
  });
});