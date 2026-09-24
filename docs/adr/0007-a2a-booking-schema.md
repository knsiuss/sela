# ADR 0007 — Define a Minimal A2A Booking Schema Above the Protocol

## Status

Proposed

Date: 24 Sep 2026

## Context

The A2A standard at [a2a-protocol.org/latest/](https://a2a-protocol.org/latest/) provides an open communication and interoperability layer for agents, including Agent Card discovery, delegation, and the JSON-RPC task lifecycle. It does **not** define appointment semantics. In particular, it does not settle how a customer agent and a merchant agent express a booking request, slot offers, scoped consent, idempotent retries, expiry, or responsibility when a proposed appointment fails.

The strategy document classifies an A2A merchant handshake as Tier 2 E: Blockit demonstrates agent-to-agent calendar negotiation in a closed network, while no public A2A booking schema is available. A pilot needs an explicit, reviewable contract before an HTTP, SDK, or live counterparty integration can be attempted.

## Decision

We will define a small, open, JSON-schema-friendly booking contract above A2A in `packages/a2a-booking/`. It will use a pure `initiated → counterparty_offered → consent_requested → consent_granted → confirmed` state machine, with explicit `rejected` and `expired` terminal states. Every booking artifact will carry an idempotency key, an opaque requester identity reference, an expiry instant, and a policy version; proposals, consent, and confirmations will also make liability information explicit.

The first implementation will remain roadmap-grade: an Agent Card validator will require a signature **field** but will not perform cryptography, identity authentication, HTTP, or A2A SDK integration. The in-memory transport is only a deterministic protocol mock.

## Alternatives Considered

- **Become a complete A2A service immediately** — rejected because appointment semantics, consent evidence, identity trust, liability, persistence, and transport are unresolved. A service would imply production interoperability that this design does not provide.
- **Wait for a formal A2A appointment standard** — rejected as the only option because it would leave the closed-network roadmap without a shared contract to test. Waiting remains a future compatibility path, not a reason to leave the current gap undocumented.

## Consequences

**Positive:**

- We become an early mover with a small, inspectable vocabulary for closed-network interoperability experiments.
- Consent, idempotency, expiry, policy versioning, and liability are visible before a booking is confirmed.
- A future transport can implement the same types without coupling this decision to a particular merchant or A2A SDK.
- The contract and state transitions are testable without live services or sensitive data.

**Negative / trade-offs accepted:**

- We accept the risk that the A2A standard or an ecosystem extension will change the vocabulary, require different identifiers, or supersede parts of this proposal.
- Consumers may treat a placeholder signature or opaque identity reference as more assurance than it provides; production documentation and audits must keep those limitations prominent.
- The initial schema is intentionally incomplete: real identity, consent proof, authorization, durable idempotency, liability review, calendar writes, and protocol transport remain out of scope.
- Early participants may need a compatibility adapter if a future standard adopts a different booking model.

**Future:**

- Submit the open schema and state-machine semantics to the A2A community/working group for discussion and versioning.
- Revisit this ADR if A2A defines appointment semantics or if multiple closed-network participants require a different contract.
- Add an authenticated transport and persistence only after the liability and consent model receives a security/privacy review.
