# @repo/a2a-booking

Roadmap-grade schema and protocol layer for a customer-agent-to-merchant-agent booking handshake. It is intentionally an application-layer design above [A2A](https://a2a-protocol.org/latest/): the A2A specification covers agent discovery, delegation, and the JSON-RPC task lifecycle, but it does not define appointment, consent, idempotency, or liability semantics.

> **Warning:** **Do NOT claim as production-ready; no live counterparty integrated; identity/signature NOT implemented — placeholder only.**

## Status

- **Roadmap / closed-network proof of concept.**
- No HTTP server, live counterparty, A2A SDK, database, payment flow, or calendar write is included.
- The package contains only TypeScript contracts, a pure state machine, an in-memory transport mock, and fail-closed validation.
- The card `signature` field is a presence-checked placeholder; this package does not create or verify cryptographic signatures.
- Identity references are opaque routing references, not authenticated identities or authorization proof.

## Handshake

The customer agent starts with a `BookingRequest`. The merchant returns a `BookingProposal` containing `SlotOffer` values and explicit `ConsentScope` requirements. The customer agent obtains a `ConsentGrant` and only then asks the merchant to produce a `BookingConfirmation`.

```text
Customer agent                              Merchant agent
     |                                             |
     |  BookingRequest                             |
     |-------------------------------------------->|
     |                                             |
     |  BookingProposal + SlotOffer[]              |
     |<--------------------------------------------|
     |                                             |
     |  consent_requested                         |
     |                                             |
     |  ConsentGrant (scoped, expiring)            |
     |-------------------------------------------->|
     |                                             |
     |  BookingConfirmation (selected offer)      |
     |<--------------------------------------------|
     |                                             |
     |  confirmed                                 |
```

The pure state machine accepts only this path:

```text
initiated
  -> counterparty_offered
  -> consent_requested
  -> consent_granted
  -> confirmed
```

`rejected` and `expired` are terminal outcomes available from each non-terminal state. Any other transition throws `IllegalHandshakeTransitionError`.

## Modules

- `src/booking_schema.ts` — JSON-schema-friendly request, proposal, offer, consent, and confirmation contracts. Every artifact carries `idempotency_key`, opaque `requester_identity_ref`, `expires_at_iso`, and `policy_version`.
- `src/agent_card.ts` — fail-closed merchant card builder/validator for vertical/action discovery, consent requirements, endpoint shape, policy, and a signature placeholder.
- `src/handshake.ts` — pure state transitions and the `MerchantAgentTransport` port.
- `src/merchant_transport.ts` — deterministic `InMemoryMerchantAgentTransport` mock. The mock caches proposals and confirmations by idempotency key; it performs no network I/O.
- `src/verification.ts` — incoming-artifact validation for consent binding, idempotency, expiry, and exact policy-version matching.
- `src/index.ts` — package barrel.

## Verification rules

`verify_booking()` is intentionally fail-closed. It rejects malformed context or payloads, missing/malformed consent, consent scope or identity mismatches, expired artifacts, policy mismatches, and an already-seen idempotency key. It returns a reason instead of throwing for expected policy rejections. An adapter should only persist the artifact after a successful result and should atomically record its idempotency key.

The verifier is a schema/policy boundary, not an identity, consent authenticity, or signature service. Production code must add trusted identity resolution, a real consent source, durable storage, authorization, and a cryptographic signature/key-distribution design. The card declares `cancel_booking` for discovery, but cancellation wire semantics are intentionally outside this minimal booking handshake.

## Open design / future work

This package intentionally proposes a small, explicit vocabulary so closed-network participants can discuss the contract before an A2A appointment working group or extension exists. The next milestones are a governed schema registry/versioning policy, real Agent Card interoperability, a transport adapter, durable idempotency, authenticated consent evidence, liability review, and integration with a merchant booking system.
