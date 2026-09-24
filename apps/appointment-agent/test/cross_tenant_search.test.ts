import { describe, expect, it } from "vitest";
import {
  InMemoryTenantAvailabilityProvider,
  SlotBroker,
  type SearchIntent,
  type TenantAvailability,
  type TenantAvailabilityProvider,
} from "@repo/slot-broker";
import {
  cross_tenant_search_node,
  is_cross_tenant_search_message,
  type CrossTenantSearchAuthorizer,
} from "../src/cross_tenant_search.js";

const AUTHORIZED: CrossTenantSearchAuthorizer = {
  can_search: () => true,
};

const BASE_INTENT: SearchIntent = {
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

describe("cross-tenant search node", () => {
  it("test_routes_the_explicit_cross_tenant_intent", () => {
    expect(is_cross_tenant_search_message("cari slot minggu ini di klinik terdekat")).toBe(true);
    expect(is_cross_tenant_search_message("I need to reschedule my appointment")).toBe(false);
  });

  it("test_returns_two_partner_offers_after_explicit_consent", async () => {
    const provider = new InMemoryTenantAvailabilityProvider([
      make_availability("tenant_a", "Clinic A", "2026-09-24T08:00:00Z"),
      make_availability("tenant_b", "Salon B", "2026-09-24T09:00:00Z"),
    ]);
    const result = await cross_tenant_search_node(
      {
        intent: BASE_INTENT,
        user_message: "cari slot minggu ini di klinik terdekat",
      },
      new SlotBroker(provider),
      AUTHORIZED,
    );

    expect(result.status).toBe("offers");
    expect(result.offers).toHaveLength(2);
    expect(result.offers[0]?.consent_card.actions.choose).toBe("Choose");
    expect(result.offers[0]?.consent_card.actions.decline).toBe("Not now");
    expect(result.requires_human_approval).toBe(true);
  });

  it("test_consent_false_does_not_query_any_partner_tenant", async () => {
    let query_count = 0;
    const provider: TenantAvailabilityProvider = {
      get_availability: async () => {
        query_count += 1;
        return [make_availability("tenant_a", "Clinic A", "2026-09-24T08:00:00Z")];
      },
    };
    const result = await cross_tenant_search_node(
      {
        intent: { ...BASE_INTENT, consent_granted: false },
        user_message: "cari slot minggu ini di klinik terdekat",
      },
      new SlotBroker(provider),
      AUTHORIZED,
    );

    expect(query_count).toBe(0);
    expect(result.status).toBe("consent_required");
    expect(result.offers).toEqual([]);
    expect(result.user_message).toContain("opt in");
  });

  it("test_returns_a_safe_message_when_partner_availability_fails", async () => {
    const provider: TenantAvailabilityProvider = {
      get_availability: async () => {
        throw new Error("provider failure detail");
      },
    };
    const result = await cross_tenant_search_node(
      { intent: BASE_INTENT, user_message: "cari slot minggu ini di klinik terdekat" },
      new SlotBroker(provider),
      AUTHORIZED,
    );

    expect(result.status).toBe("provider_unavailable");
    expect(result.user_message).not.toContain("provider failure detail");
    expect(result.offers).toEqual([]);
  });

  it("test_fails_closed_when_authorization_raises", async () => {
    let query_count = 0;
    const provider: TenantAvailabilityProvider = {
      get_availability: async () => {
        query_count += 1;
        return [make_availability("tenant_a", "Clinic A", "2026-09-24T08:00:00Z")];
      },
    };
    const result = await cross_tenant_search_node(
      { intent: BASE_INTENT, user_message: "cari slot minggu ini di klinik terdekat" },
      new SlotBroker(provider),
      {
        can_search: () => {
          throw new Error("authorization unavailable");
        },
      },
    );

    expect(result.status).toBe("not_authorized");
    expect(query_count).toBe(0);
  });

  it("test_fails_closed_when_the_conversation_is_not_authorized", async () => {
    let query_count = 0;
    const provider: TenantAvailabilityProvider = {
      get_availability: async () => {
        query_count += 1;
        return [make_availability("tenant_a", "Clinic A", "2026-09-24T08:00:00Z")];
      },
    };
    const result = await cross_tenant_search_node(
      { intent: BASE_INTENT, user_message: "cari slot minggu ini di klinik terdekat" },
      new SlotBroker(provider),
      { can_search: () => false },
    );

    expect(result.status).toBe("not_authorized");
    expect(query_count).toBe(0);
    expect(result.offers).toEqual([]);
  });
});
