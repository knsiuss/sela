import { describe, expect, it } from "vitest";
import { build_offers } from "../src/offer_builder.js";
import type { MatchedSlot, SearchIntent } from "../src/types.js";

const intent: SearchIntent = {
  requester_tenant_id: "tenant_requester",
  consent_granted: true,
  vertical: "clinic",
  locale: "id-ID",
  start_time: "2026-09-24T00:00:00Z",
  end_time: "2026-10-01T00:00:00Z",
};

function make_slot(tenant_id: string, tenant_name: string, slot_id: string): MatchedSlot {
  return {
    tenant_id,
    tenant_name,
    slot_id,
    start_time: "2026-09-28T08:00:00Z",
    end_time: "2026-09-28T08:30:00Z",
    created_at: "2026-09-24T08:00:00Z",
    vertical: "clinic",
    locale: "id-ID",
  };
}

describe("offer builder", () => {
  it("builds one consent card per slot and summarizes all ranked tenants", () => {
    const offers = build_offers(
      [
        make_slot("tenant_a", "Clinic A", "slot_a"),
        make_slot("tenant_b", "Salon B", "slot_b"),
        make_slot("tenant_c", "Clinic C", "slot_c"),
      ],
      intent,
    );

    expect(offers).toHaveLength(3);
    expect(offers[0]?.summary).toBe("3 slots available at: Clinic A, Salon B, Clinic C");
    expect(offers.every((offer) => offer.consent_card.card_type === "slot_consent")).toBe(true);
    expect(offers.every((offer) => offer.consent_card.requires_explicit_response)).toBe(true);
    expect(offers.every((offer) => offer.booking_state === "not_booked")).toBe(true);
  });
});
