import { describe, expect, it } from "vitest";
import { filter_eligible_tenants } from "../src/eligibility.js";
import type { SearchIntent, TenantAvailability } from "../src/types.js";

const intent: SearchIntent = {
  requester_tenant_id: "tenant_requester",
  consent_granted: true,
  vertical: "clinic",
  locale: "id-ID",
  start_time: "2026-09-24T00:00:00Z",
  end_time: "2026-10-01T00:00:00Z",
};

function make_availability(overrides: Partial<TenantAvailability> = {}): TenantAvailability {
  return {
    tenant_id: "tenant_partner",
    tenant_name: "Clinic Partner",
    vertical: "clinic",
    locale: "id-ID",
    consent_granted: true,
    has_partner_contract: true,
    created_at: "2026-09-24T08:00:00Z",
    slots: [
      {
        slot_id: "slot_partner_1",
        start_time: "2026-09-28T08:00:00Z",
        end_time: "2026-09-28T08:30:00Z",
      },
    ],
    ...overrides,
  };
}

describe("tenant eligibility", () => {
  it("excludes a tenant without consent or partner contract with audit reasons", () => {
    const result = filter_eligible_tenants(intent, [
      make_availability({
        tenant_id: "tenant_without_permission",
        consent_granted: false,
        has_partner_contract: false,
      }),
    ]);

    expect(result.eligible_tenants).toHaveLength(0);
    expect(result.excluded_tenants[0]).toMatchObject({
      tenant_id: "tenant_without_permission",
      reason: "tenant_consent_not_granted",
      reasons: ["tenant_consent_not_granted", "partner_contract_missing"],
      audit_reason: "tenant_consent_not_granted|partner_contract_missing",
    });
  });

  it("excludes a tenant when only the partner contract is missing", () => {
    const result = filter_eligible_tenants(intent, [
      make_availability({ tenant_id: "tenant_without_contract", has_partner_contract: false }),
    ]);

    expect(result.excluded_tenants[0]?.reasons).toEqual(["partner_contract_missing"]);
  });

  it("excludes the requester tenant even when its metadata would otherwise match", () => {
    const result = filter_eligible_tenants(intent, [
      make_availability({ tenant_id: intent.requester_tenant_id }),
    ]);

    expect(result.eligible_tenants).toHaveLength(0);
    expect(result.excluded_tenants[0]?.reasons).toContain("requester_tenant_excluded");
  });

  it("excludes vertical and locale mismatches without returning partner slots", () => {
    const result = filter_eligible_tenants(intent, [
      make_availability({ vertical: "salon", locale: "en-US" }),
    ]);

    expect(result.excluded_tenants[0]?.reasons).toEqual(["vertical_mismatch", "locale_mismatch"]);
    expect(result.excluded_tenants[0]).not.toHaveProperty("slots");
  });
});
