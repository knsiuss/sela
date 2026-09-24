import { describe, expect, it, vi } from "vitest";
import { AvailabilityProviderError, SlotBroker } from "../src/broker.js";
import { InMemoryTenantAvailabilityProvider } from "../src/in_memory_availability_provider.js";
import { SlotBrokerValidationError } from "../src/validation.js";
import { FCFS_POLICY_VERSION } from "../src/types.js";
import type {
  SearchIntent,
  TenantAvailability,
  TenantAvailabilityProvider,
} from "../src/types.js";

const intent: SearchIntent = {
  requester_tenant_id: "tenant_requester",
  consent_granted: true,
  vertical: "clinic",
  locale: "id-ID",
  start_time: "2026-09-24T00:00:00Z",
  end_time: "2026-10-01T00:00:00Z",
};

function make_availability(tenant_id: string, tenant_name: string, created_at: string): TenantAvailability {
  return {
    tenant_id,
    tenant_name,
    vertical: "clinic",
    locale: "id-ID",
    consent_granted: true,
    has_partner_contract: true,
    created_at,
    slots: [
      {
        slot_id: `${tenant_id}_slot`,
        start_time: "2026-09-28T08:00:00Z",
        end_time: "2026-09-28T08:30:00Z",
      },
    ],
  };
}

function make_provider(availabilities: TenantAvailability[]): TenantAvailabilityProvider {
  return {
    get_availability: vi.fn(async () => availabilities),
  };
}

describe("SlotBroker", () => {
  it("returns offers with consent cards and never calls a calendar mutation port", async () => {
    const calendar_port = {
      hold_slot: vi.fn(),
      confirm_booking: vi.fn(),
      cancel_booking: vi.fn(),
    };
    const provider = make_provider([
      make_availability("tenant_a", "Clinic A", "2026-09-24T08:00:00Z"),
      make_availability("tenant_b", "Salon B", "2026-09-24T09:00:00Z"),
    ]);
    const broker = new SlotBroker(provider);

    const offers = await broker.search(intent);

    expect(offers).toHaveLength(2);
    expect(offers[0]?.summary).toBe("2 slots available at: Clinic A, Salon B");
    expect(offers[0]?.consent_card.actions).toEqual({ choose: "Choose", decline: "Not now" });
    expect(offers[0]?.requires_human_approval).toBe(true);
    expect(offers[0]?.booking_state).toBe("not_booked");
    expect(offers[0]?.policy_version).toBe(FCFS_POLICY_VERSION);
    expect(calendar_port.hold_slot).not.toHaveBeenCalled();
    expect(calendar_port.confirm_booking).not.toHaveBeenCalled();
    expect(calendar_port.cancel_booking).not.toHaveBeenCalled();
  });

  it("does not query partner tenants when requester consent is false", async () => {
    const get_availability = vi.fn(async () => [
      make_availability("tenant_a", "Clinic A", "2026-09-24T08:00:00Z"),
    ]);
    const broker = new SlotBroker({ get_availability });

    const offers = await broker.search({ ...intent, consent_granted: false });

    expect(offers).toEqual([]);
    expect(get_availability).not.toHaveBeenCalled();
  });

  it("rejects malformed intent before invoking the provider", async () => {
    let query_count = 0;
    const provider: TenantAvailabilityProvider = {
      get_availability: async () => {
        query_count += 1;
        return [];
      },
    };
    const malformed_intent = { ...intent, consent_granted: "yes" } as unknown as SearchIntent;
    const broker = new SlotBroker(provider);

    await expect(broker.search(malformed_intent)).rejects.toBeInstanceOf(SlotBrokerValidationError);
    expect(query_count).toBe(0);
  });

  it("makes the in-memory provider refuse a direct no-consent read", async () => {
    const provider = new InMemoryTenantAvailabilityProvider([
      make_availability("tenant_a", "Clinic A", "2026-09-24T08:00:00Z"),
    ]);

    await expect(provider.get_availability({ ...intent, consent_granted: false })).resolves.toEqual([]);
  });

  it("translates provider failures without exposing the provider message", async () => {
    const provider: TenantAvailabilityProvider = {
      get_availability: async () => {
        throw new Error("provider failure detail");
      },
    };
    const broker = new SlotBroker(provider);

    const error = await broker.search(intent).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AvailabilityProviderError);
    expect(String(error)).not.toContain("provider failure detail");
  });

  it("returns an auditable result without exposing excluded tenant slots", async () => {
    const broker = new SlotBroker(
      make_provider([
        make_availability("tenant_a", "Clinic A", "2026-09-24T08:00:00Z"),
        {
          ...make_availability("tenant_blocked", "Blocked Clinic", "2026-09-24T08:00:00Z"),
          consent_granted: false,
          has_partner_contract: false,
        },
      ]),
    );

    const result = await broker.search_with_audit(intent);

    expect(result.offers).toHaveLength(1);
    expect(result.audit.eligibility.excluded_tenants[0]?.reasons).toEqual([
      "tenant_consent_not_granted",
      "partner_contract_missing",
    ]);
    expect(result.audit.eligibility).not.toHaveProperty("eligible_tenants");
    expect(JSON.stringify(result.audit)).not.toContain("slot_a");
  });
});
