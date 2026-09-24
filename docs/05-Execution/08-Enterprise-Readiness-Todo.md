# 08 — Enterprise Readiness TODO

> **Purpose:** Execution backlog for moving the Path A WhatsApp appointment agent from a hardened MVP backend to an enterprise-grade production service.
>
> **Status date:** 25 September 2026
> **Repository branch at creation:** `feature/tenant-aware-whatsapp-worker`
> **Implementation baseline:** `fc8f7b6` (before this documentation commit)
> **Important:** This document is a readiness checklist, not a claim that the system is already enterprise-ready.

## Status legend

- `[x]` Complete with verifiable evidence.
- `[~]` In progress or partially complete.
- `[ ]` Not started.
- `[!]` Blocked; record the blocker and owner.

A checkbox may only be marked complete when the evidence column or linked artifact exists. A passing unit test alone is not sufficient for a production gate.

## Current baseline

### Completed foundation

- [x] HMAC-verified WhatsApp HTTP ingress.
- [x] Explicit channel-to-tenant resolution.
- [x] Tenant-scoped inbound deduplication.
- [x] Atomic inbound claim + retained inbound row + PII-free worker job transaction.
- [x] AES-GCM encrypted reply target with plaintext phone excluded from queue payloads.
- [x] Bounded worker claims, leases, fencing tokens, retries, and lifecycle transitions.
- [x] Customer-confirmed reschedule session with generation-bound button actions.
- [x] Explicit customer confirmation requirement for calendar-changing actions.
- [x] Tenant-aware outbound sender registry with fail-closed unmapped-tenant behavior.
- [x] Meta Graph origin, port, redirect, timeout, and token-bearing request protections.
- [x] 24-hour customer service-window behavior and non-promotional utility boundary.
- [x] Langfuse/observability integration point exists in the architecture.
- [x] Current automated baseline: 32 appointment-agent test files / 224 tests passing; workspace typecheck, build, and frozen install pass.

### Known release blockers

- [ ] The current reschedule flow confirms a selected hold but does not atomically replace an existing appointment.
- [ ] The default calendar writer is process-local and is not durable across workers or restarts.
- [ ] There is no complete ambiguous-commit reconciliation system for ingress and outbound delivery.
- [ ] Outbound idempotency and delivery status are not durable across processes.
- [ ] No production-like Supabase/Postgres role, RLS, TLS, backup, and restore verification is committed as an integration test.
- [ ] No live Meta WABA, approved utility template, signed webhook, or delivery-status smoke test has been completed.
- [ ] Retention purge, tenant deletion, key rotation, and operational data lifecycle are not complete.
- [ ] The explicit multi-tenant registry marker asserts deployment coverage but does not yet health-check actual tenant coverage.
- [ ] `docs/README.md` contains unrelated working-tree changes and must not be staged accidentally.

## Priority model

| Priority | Meaning | Gate |
|---|---|---|
| **P0** | Correctness, security, or data-loss risk | Required before any production traffic |
| **P1** | Pilot reliability and operational readiness | Required before a customer pilot |
| **P2** | Enterprise governance, identity, and product operations | Required before enterprise GA |
| **P3** | Scale, resilience, and optimization | Required for the target scale contract |

---

# P0 — Production safety and correctness

## P0.1 Atomic reschedule domain contract

**Owner:** Backend / Scheduling
**Depends on:** Current reschedule session and calendar port

- [ ] Define a tenant-scoped `AppointmentRepository` read port.
- [ ] Persist `appointment_id` in the reschedule session.
- [ ] Persist the source appointment version or `updated_at` fingerprint.
- [ ] Define `CalendarPort.reschedule_appointment(...)` with an explicit idempotency key.
- [ ] Validate appointment ownership before any mutation.
- [ ] Validate the source appointment is in a reschedulable state.
- [ ] Validate the target hold belongs to the same tenant and target slot.
- [ ] Atomically replace the old appointment and confirm the new slot.
- [ ] Preserve the old appointment if any part of the operation fails.
- [ ] Return a stable domain result only after the calendar transaction commits.
- [ ] Emit an audit event for accepted, rejected, expired, and conflicted operations.
- [ ] Never infer an appointment ID from untrusted free text.
- [ ] Require the explicit `confirm_move` action for the state-changing write.

### Required tests

- [ ] Successful reschedule with one calendar mutation.
- [ ] Wrong-tenant appointment is rejected before calendar access.
- [ ] Missing appointment is rejected safely.
- [ ] Stale appointment version is rejected.
- [ ] Expired target hold is rejected or re-offered.
- [ ] Target slot becomes unavailable.
- [ ] Concurrent reschedule attempts cannot double-move an appointment.
- [ ] Retry after an ambiguous commit is idempotent.
- [ ] Failure leaves the original appointment unchanged.
- [ ] Duplicate confirmation does not create a second appointment.
- [ ] Confirmed cancellation is never silently treated as a reschedule.

**Done evidence:** API/port contract, migration, unit tests, integration test, audit-event example, and runbook.

## P0.2 Durable calendar and hold persistence

- [ ] Replace the process-local default calendar state in production composition.
- [ ] Define a durable calendar writer backed by Postgres or an approved provider.
- [ ] Persist appointment and hold ownership in the tenant scope.
- [ ] Make hold acquisition idempotent by `(tenant_id, slot_id, operation_key)`.
- [ ] Make hold confirmation idempotent by `(tenant_id, hold_id, operation_key)`.
- [ ] Make hold release idempotent.
- [ ] Enforce one active writer for a slot/resource.
- [ ] Add stale hold recovery and lease/claim fencing where required.
- [ ] Define conflict behavior when provider availability changes during confirmation.
- [ ] Add provider error classification and bounded retry rules.
- [ ] Keep display names and provider IDs separate from stable identifiers.
- [ ] Add reconciliation for calendar writes that time out after provider acceptance.

**Done evidence:** Durable adapter tests, database constraints/indexes, provider contract tests, and an operational recovery runbook.

## P0.3 Inbound reconciliation and orphan repair

- [ ] Add a durable ingress status ledger or equivalent state machine.
- [ ] Distinguish `accepted`, `duplicate`, `reconciling`, `needs_repair`, and `failed` states.
- [ ] Detect claims without a complete active job.
- [ ] Detect jobs without the required retained inbound row.
- [ ] Detect rows left between external provider acceptance and local commit.
- [ ] Provide an explicit repair/quarantine command; never delete claims automatically.
- [ ] Record repair actor, reason, timestamp, and resulting state.
- [ ] Alert when repair age exceeds the operational threshold.
- [ ] Add a scheduled reconciliation job with bounded batches.
- [ ] Add a dead-letter path for messages that cannot be repaired safely.
- [ ] Define customer-support behavior for messages that require manual replay.

**Done evidence:** Reconciliation queries, repair runbook, alert, and a migration/integration fixture for active and terminal orphan cases.

## P0.4 Outbound idempotency and delivery ledger

- [ ] Add a durable outbound idempotency ledger keyed by tenant, provider, and operation.
- [ ] Persist lifecycle states: `pending`, `sending`, `sent`, `delivered`, `failed`, `unknown`.
- [ ] Store provider message ID and safe provider response code only.
- [ ] Never persist plaintext recipient, message content, or access token in the ledger.
- [ ] Make retries safe after process restart.
- [ ] Handle partial success when one job produces multiple drafts.
- [ ] Add reconciliation for `sending` records left by a crashed worker.
- [ ] Add delivery-status webhook ingestion and signature validation.
- [ ] Define retry limits and terminal failure handling.
- [ ] Add operator replay that requires an explicit audited action.

**Done evidence:** Schema, adapter tests, delivery-status contract, replay tests, and provider failure runbook.

## P0.5 Database, RLS, and migration production gate

- [ ] Apply migrations `0001`–`0011` to a production-like Supabase/Postgres environment.
- [ ] Verify migration ordering and rerun behavior.
- [ ] Verify `0001`-`0011` schema checks and constraints with real PostgreSQL.
- [ ] Build a role matrix for `anon`, `authenticated`, `service_role`, migration role, and read-only analytics role.
- [ ] Test RLS allow/deny behavior for every tenant-owned table.
- [ ] Test cross-tenant reads and writes for all business entities.
- [ ] Verify `processed_messages` remains server-only.
- [ ] Verify sequence privileges for service-role writes.
- [ ] Verify TLS is required for all non-local connections.
- [ ] Verify connection, statement, and transaction timeout settings.
- [ ] Verify pool exhaustion behavior.
- [ ] Test backup creation and point-in-time restore.
- [ ] Commit a reproducible database integration test to CI.
- [ ] Document migration preflight and rollback/recovery procedures.

**Done evidence:** CI integration job, role/RLS test output, restore report, and migration runbook.

## P0.6 Secrets, cryptography, and key lifecycle

- [ ] Store Meta credentials in a secret manager.
- [ ] Resolve sender credentials per tenant at runtime.
- [ ] Remove any process-global credential fallback for database-backed mode.
- [ ] Define recipient encryption-key ownership and rotation.
- [ ] Add key version metadata to retained ciphertext if rotation is required.
- [ ] Define encryption context/AAD binding.
- [ ] Test key rotation with old/new key overlap.
- [ ] Test emergency credential revocation.
- [ ] Add secret access audit events without logging secret values.
- [ ] Add repository secret scanning and CI push protection.
- [ ] Document break-glass access and approval requirements.

**Done evidence:** Secret-manager integration test, rotation drill, access policy, and incident procedure.

## P0.7 Retention, deletion, and data lifecycle

- [ ] Define retention periods for inbound content, sessions, jobs, outbound ledger, and audit data.
- [ ] Implement a purge worker for expired data.
- [ ] Make purge idempotent and observable.
- [ ] Implement tenant deletion with cascade/quarantine semantics.
- [ ] Implement customer data export.
- [ ] Implement legal hold behavior.
- [ ] Define anonymization rules for analytics and support views.
- [ ] Prevent deleted tenant data from reappearing through caches or sessions.
- [ ] Test retention cleanup while preserving valid terminal dedupe/job records.
- [ ] Publish a customer-facing privacy and retention policy.

**Done evidence:** Data inventory, deletion test, purge metrics, and signed data-lifecycle runbook.

## P0.8 Meta production integration gate

- [ ] Provision and verify the Meta WABA.
- [ ] Verify the production phone number.
- [ ] Create and obtain approval for all required utility templates.
- [ ] Confirm templates are non-promotional and use the correct language/category.
- [ ] Configure the 24-hour customer service-window behavior against live provider responses.
- [ ] Run a signed webhook smoke test.
- [ ] Run inbound text, button, duplicate, and handoff scenarios.
- [ ] Run a live outbound text reply and delivery-status callback.
- [ ] Verify token permissions are least-privilege.
- [ ] Verify provider error, rate-limit, timeout, and revoked-token behavior.
- [ ] Record provider request IDs and safe diagnostics in structured logs.

Provider source of truth:

- https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages

**Done evidence:** Approved template IDs, live smoke-test record, provider test evidence, and support runbook.

---

# P1 — Pilot reliability and operations

## P1.1 Observability and service levels

- [ ] Add OpenTelemetry traces across HTTP, ingress, worker, calendar, and outbound boundaries.
- [ ] Propagate correlation IDs without raw message content.
- [ ] Add Langfuse traces for graph/turn decisions with PII filtering.
- [ ] Define metrics for:
  - webhook latency;
  - queue depth and oldest job age;
  - claim latency;
  - transaction duration;
  - hold expiry;
  - reschedule success/failure;
  - outbound delivery latency;
  - provider errors;
  - reconciliation backlog;
  - purge backlog.
- [ ] Define SLOs for availability, ingress acceptance, worker processing, and delivery.
- [ ] Define error-budget policy.
- [ ] Build operational dashboards.
- [ ] Define paging thresholds and escalation paths.
- [ ] Test alert delivery and deduplication.

**Done evidence:** Dashboard links, SLO document, alert tests, and on-call runbook.

## P1.2 Reliability and failure testing

- [ ] Load-test webhook ingress.
- [ ] Load-test worker claims and processing.
- [ ] Test same-tenant concurrent messages.
- [ ] Test concurrent reschedules for one appointment.
- [ ] Inject database latency and pool exhaustion.
- [ ] Inject provider timeout and provider success-after-timeout.
- [ ] Kill workers before and after each transaction boundary.
- [ ] Kill workers after calendar acceptance and before session commit.
- [ ] Kill workers after sender acceptance and before delivery-status persistence.
- [ ] Test retry storms and backoff.
- [ ] Test graceful shutdown and job lease recovery.
- [ ] Run a chaos exercise with a documented result.

**Done evidence:** Test reports, capacity numbers, failure matrix, and remediation actions.

## P1.3 CI/CD and release controls

- [ ] Require typecheck, unit tests, integration tests, migration checks, and build in CI.
- [ ] Add dependency and license scanning.
- [ ] Add SAST and secret scanning.
- [ ] Generate an SBOM for release artifacts.
- [ ] Build immutable container images.
- [ ] Add staging deployment with migration preflight.
- [ ] Add canary or blue/green release for the worker and HTTP server.
- [ ] Add feature flags for risky provider behavior.
- [ ] Test rollback with and without database migration rollback.
- [ ] Require protected branches and reviewed changesets.
- [ ] Publish release notes and migration notes automatically.
- [ ] Define emergency revert authority.

**Done evidence:** CI run, image/SBOM artifact, canary test, and rollback rehearsal.

## P1.4 Runbooks and incident response

- [ ] Write ingress outage runbook.
- [ ] Write queue backlog runbook.
- [ ] Write orphan-claim repair runbook.
- [ ] Write calendar provider outage runbook.
- [ ] Write Meta outage/rate-limit runbook.
- [ ] Write key-compromise runbook.
- [ ] Write data-deletion incident runbook.
- [ ] Define incident severity levels.
- [ ] Define incident commander and communications roles.
- [ ] Create postmortem template and schedule reviews.
- [ ] Test an on-call handoff exercise.

**Done evidence:** Linked runbooks, tabletop exercise record, and postmortem template.

## P1.5 Backup, restore, and disaster recovery

- [ ] Define RPO and RTO with product/business approval.
- [ ] Enable automated backups.
- [ ] Enable point-in-time recovery where supported.
- [ ] Test full database restore.
- [ ] Test object/config secret restore separately from database restore.
- [ ] Document rebuild order for migrations, workers, HTTP server, and providers.
- [ ] Test provider credential revocation during recovery.
- [ ] Publish disaster-recovery exercise results.

---

# P2 — Enterprise product and governance

## P2.1 Identity and access management

- [ ] Select enterprise identity provider.
- [ ] Implement OIDC or SAML SSO.
- [ ] Implement MFA for privileged roles.
- [ ] Implement user lifecycle: invite, activate, suspend, revoke.
- [ ] Implement organization → tenant → location hierarchy.
- [ ] Implement RBAC roles:
  - owner;
  - admin;
  - operator;
  - support;
  - analyst;
  - developer.
- [ ] Add API keys with explicit scopes and expiry.
- [ ] Add session revocation and device history.
- [ ] Add privileged-action approval for destructive operations.
- [ ] Add access-review reporting.

**Done evidence:** IAM design, role matrix, SSO tests, and access-review procedure.

## P2.2 Operator workspace

- [ ] Build handoff queue.
- [ ] Add tenant-safe appointment lookup.
- [ ] Add masked conversation context.
- [ ] Add reschedule/cancel approval actions.
- [ ] Add conflict resolution UI/state.
- [ ] Add assignment and escalation workflow.
- [ ] Add SLA timers.
- [ ] Add audit timeline.
- [ ] Add manual replay with confirmation and audit event.
- [ ] Add role-based access checks to every mutation.
- [ ] Add accessibility and keyboard/screen-reader coverage.

**Done evidence:** Operator design, permission tests, accessibility audit, and support workflow.

## P2.3 Enterprise APIs and integrations

- [ ] Publish versioned public API contracts.
- [ ] Add authenticated webhooks for appointment changes.
- [ ] Sign outbound webhooks.
- [ ] Define webhook replay and idempotency semantics.
- [ ] Add API rate limits.
- [ ] Add API key rotation and revocation.
- [ ] Complete Google Calendar OAuth and production consent flow.
- [ ] Add provider-specific error contracts.
- [ ] Select and implement the first PMS/CRM adapter only after the core contract is stable.
- [ ] Add contract tests for every external adapter.

**Done evidence:** OpenAPI/event contracts, adapter test suite, and integration runbooks.

## P2.4 Compliance and governance

- [ ] Complete threat model and data-flow diagram.
- [ ] Complete privacy impact assessment.
- [ ] Publish privacy policy and data-processing terms.
- [ ] Maintain subprocessor inventory.
- [ ] Define data residency requirements.
- [ ] Define audit-log retention and export.
- [ ] Define vulnerability disclosure process.
- [ ] Run an independent penetration test.
- [ ] Remediate high/critical findings before GA.
- [ ] Define vendor and provider security review process.
- [ ] Define customer security questionnaire responses.
- [ ] Establish access-review and evidence-retention cadence.

**Done evidence:** Signed security/compliance artifacts and remediation tracker.

---

# P3 — Scale and optimization

## P3.1 Capacity and cost engineering

- [ ] Define traffic model per tenant and per location.
- [ ] Define peak webhook, worker, and provider concurrency.
- [ ] Load-test at target volume plus agreed headroom.
- [ ] Define pool, queue, database, and provider capacity limits.
- [ ] Add per-tenant rate limits and fairness controls.
- [ ] Track cost per appointment and per message.
- [ ] Add budget alerts for WhatsApp, LLM, database, and observability spend.
- [ ] Define cost allocation and chargeback/reporting requirements.
- [ ] Optimize expensive provider calls without weakening confirmation/idempotency boundaries.

## P3.2 Resilience and regional operations

- [ ] Decide whether multi-region availability is required by contract.
- [ ] Define regional failover behavior.
- [ ] Define queue/database replication strategy.
- [ ] Add regional health checks and traffic policy.
- [ ] Test provider behavior during regional failure.
- [ ] Define data-residency routing.
- [ ] Run a regional disaster-recovery exercise.

## P3.3 Analytics and long-term data

- [ ] Define analytics event taxonomy.
- [ ] Keep raw message content out of analytics by default.
- [ ] Define approved aggregate metrics.
- [ ] Add data warehouse/export pipeline if required.
- [ ] Define metric reconciliation between operational and analytical stores.
- [ ] Add long-term archival and restore testing.
- [ ] Define analytics access controls.

---

# Execution order and dependencies

```text
P0.1 Atomic reschedule contract
  -> P0.2 Durable calendar writer
  -> P0.3 Inbound reconciliation
  -> P0.4 Outbound ledger
  -> P0.5 Live database/RLS/TLS verification
  -> P0.6 Secret management and key lifecycle
  -> P0.7 Retention/deletion lifecycle
  -> P0.8 Live Meta integration
  -> P1 Pilot reliability and operations
  -> P2 Enterprise identity/governance
  -> P3 Scale and regional expansion
```

Do not begin broad feature expansion while a P0 item is open. A dashboard or a second vertical must not distract from data-loss, double-booking, tenant-isolation, or provider-reliability risks.

# Release gates

## Gate A — Safe backend pilot

All boxes must be checked:

- [ ] Atomic old-appointment reschedule is implemented and tested.
- [ ] Durable calendar writer is used in the pilot composition.
- [ ] No P0 security or correctness findings remain.
- [ ] Ingress and outbound reconciliation are active.
- [ ] Production-like Postgres/RLS/TLS verification passes.
- [ ] Backup restore has been rehearsed.
- [ ] Meta WABA and utility template are approved.
- [ ] Signed webhook-to-reply smoke test passes.
- [ ] Load and failure tests meet the agreed pilot threshold.
- [ ] On-call runbooks and alerts exist.
- [ ] Pilot support and rollback procedures are approved.

## Gate B — Enterprise GA

All boxes must be checked:

- [ ] SSO/OIDC/SAML and MFA are available for privileged users.
- [ ] RBAC and organization/location hierarchy are enforced in code and UI.
- [ ] Operator workspace supports audited human handoff and repair actions.
- [ ] Security review and penetration test have no open high/critical findings.
- [ ] Privacy, retention, deletion, legal hold, and data residency are documented and tested.
- [ ] RPO/RTO and disaster-recovery exercise are approved.
- [ ] On-call ownership, incident response, and postmortem process are active.
- [ ] Public API/webhook contracts are versioned and documented.
- [ ] SLOs and error budgets are measured.
- [ ] Capacity and cost limits are enforced.

# Open decisions

- [ ] Which beachhead vertical and location are the first enterprise customer target?
- [ ] Is Supabase managed Postgres acceptable, or is self-managed Postgres required?
- [ ] What are the target RPO and RTO?
- [ ] What are the approved data-residency regions?
- [ ] Which identity provider is required for the first enterprise customer?
- [ ] What is the authoritative source for the existing appointment ID?
- [ ] Should completed historical dedupe claims be retained indefinitely or archived?
- [ ] What is the required retention period for message content and audit logs?
- [ ] Which external PMS/CRM is the first production adapter after Google Calendar?
- [ ] What tenant coverage health check is required for an injected all-tenant sender registry?
- [ ] What is the minimum enterprise SLA and support response time?

# Definition of Done for each TODO

Every completed item must link to at least one of:

- A passing automated test.
- A migration and migration verification.
- A live staging smoke test.
- A runbook.
- An architecture/design document.
- A measured production-like test report.
- A signed security/compliance artifact.
- An audited operational exercise.

A code change without an operational owner, failure behavior, and recovery path is not complete.

# Explicitly deferred until the gates above

- Broad dashboard development.
- Additional vertical connectors.
- Voice automation beyond escalation.
- Multi-location rollout beyond the validated pilot.
- Multi-region deployment without an RTO/RPO requirement.
- Promotional messaging or marketing automation.
- Meta Business Agent as the primary execution engine.

# Maintenance rule

Review this file at every release gate. When an item is completed, replace the checkbox with `[x]`, add the evidence link, update the status date, and record any new residual risk in `05-Risk-Register.md` or `07-Postmortems.md` when applicable.
