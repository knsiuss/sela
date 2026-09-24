# @repo/slot-broker

A read-only, concierge-pilot broker for finding an eligible slot across partner
businesses. The public-evidence gap for this pattern is explicit: this package
is an implementation starting point, not a claim of a proven market standard.

## Safety boundary

- `SearchIntent.consent_granted` must be exactly `true` before any provider is
  queried. A false value fails closed with no offers; malformed or missing
  intent fields are rejected before provider access.
- Each partner must have `consent_granted: true` and
  `has_partner_contract: true`.
- A tenant is excluded when its vertical or locale does not match, when it has
  no slot in the requested window, or when it is the requester tenant.
- The provider is a read port. The package has no calendar, hold, confirm, or
  booking write operation.
- Only minimum availability plus non-PII ranking metadata are copied into
  matches. Excluded tenant slot data is not returned in the audit result.
- Fairness never calls an LLM. The default policy is versioned as
  `fcfs-created-at-v1`.

## Fairness policy

`TenantAvailability.created_at` is the first-created-at timestamp. Eligible
matches are ordered by:

1. `created_at` ascending (FCFS);
2. `tenant_id` ascending when timestamps tie;
3. `slot_id` ascending when a tenant has multiple tied slots.

The policy returns at most three ranked offers. Ordering controls what a
customer sees; it does not reserve a slot or decide who ultimately receives a
booking. Every offer is `pending_human_approval`, carries a consent card with
`Choose` / `Not now` actions, and has `booking_state: "not_booked"`.

## Example

```ts
const provider = new InMemoryTenantAvailabilityProvider([
  {
    tenant_id: "clinic_a",
    tenant_name: "Clinic A",
    vertical: "clinic",
    locale: "id-ID",
    consent_granted: true,
    has_partner_contract: true,
    created_at: "2026-09-24T08:00:00Z",
    slots: [
      {
        slot_id: "slot_a1",
        start_time: "2026-09-28T08:00:00Z",
        end_time: "2026-09-28T08:30:00Z",
      },
    ],
  },
]);
const broker = new SlotBroker(provider);
const offers = await broker.search({
  requester_tenant_id: "requester_tenant",
  consent_granted: true,
  vertical: "clinic",
  locale: "id-ID",
  start_time: "2026-09-24T00:00:00Z",
  end_time: "2026-10-01T00:00:00Z",
});
```

Use `search_with_audit()` when the caller needs the eligibility decisions and
fairness plan for an audit record. It performs the same read-only search.

## Development

```bash
pnpm install
pnpm --filter @repo/slot-broker typecheck
pnpm --filter @repo/slot-broker test
```

Production integration still needs a real consent/contract source, tenant-scoped
authorization, provider timeouts and rate limits, an audited staff approval
workflow, and a separate single-writer booking path. Those are intentionally
outside this package.
