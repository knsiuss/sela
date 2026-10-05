# 08 — Enterprise Readiness TODO

> **Purpose:** Execution backlog for moving the Path A WhatsApp appointment agent from a hardened MVP backend to an enterprise-grade production service.
>
> **Status date:** 1 October 2026
> **Repository branch at creation:** `feature/tenant-aware-whatsapp-worker`
> **Implementation baseline:** `fc8f7b6` (before this documentation commit)
> **Last verified against code:** `739d8e5` (Gate A pilot attempt, 1 October 2026 — see "Residual risk")
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
- [x] Current automated baseline: the default appointment-agent suite passes with unit/reliability coverage; 21 PostgreSQL calendar/ledger and production-gate integration tests require `TEST_DATABASE_URL` and are explicitly skipped without it. Last full local run: 78 test files passed, 2 skipped; 613 tests passed, 21 skipped; monorepo `pnpm typecheck` and `pnpm test` both 14/14 green at commit `739d8e5`.
- [x] Tenant-scoped rate limiting is implemented in `src/rate_limit/tenant_rate_limiter.ts` with Postgres fixed-window and explicit local adapters.
- [x] PII-minimal outbound ledger and signed status ingestion are implemented in `src/outbound/` and `0013_rate_limit_outbound_ledger.sql`.
- [x] Metrics, SLO evaluation, alert thresholds, operator RBAC/OIDC contracts, data lifecycle, DR, and capacity contracts have executable tests.
- [~] Production approval still requires the external database, live Meta, identity-provider, DR, and operational evidence listed below.

### Known release blockers

- [~] Atomic reschedule code and migration `0012` now exist, with unit and migration contract coverage; release evidence remains blocked on a trusted appointment-id source, provider reconciliation, and a production-like PostgreSQL run.
- [~] The database-backed default now uses a durable Postgres calendar writer; migration `0013`, RLS/role checks, TLS/timeouts, and backup/restore evidence tooling exist, but external production-like evidence is not committed.
- [~] Ambiguous outbound commits are fenced as `unknown` and inbound claims fail closed; a scheduled operator reconciliation/repair worker and customer-support runbook remain open.
- [x] Outbound idempotency, lifecycle state, lease fencing, signed status ingestion, and partial-draft replay are implemented in the durable ledger path; production credential/provider reconciliation remains open.
- [~] `db:gate` performs read-only schema/RLS/role/TLS/timeout checks and requires external backup/restore evidence. Verified fail-closed in this environment: with no `DATABASE_URL` it exits 2 and emits `database_gate_blocked`; `db:restore-rehearsal` likewise exits 2 with `restore_rehearsal_blocked`. No production-like PostgreSQL run, TLS check, or backup/PITR restore rehearsal has been executed here.
- [ ] No live Meta WABA, approved utility template, signed webhook, or delivery-status smoke test has been completed because staging credentials/access were unavailable. Verified fail-closed in this environment: `smoke:meta` without `META_SMOKE_ENVIRONMENT=staging` exits 2 with `meta_staging_smoke_blocked`. No Meta credential is present in this environment, so no live call was attempted.
- [!] Pilot environment provisioning is blocked on credentials that are absent here: no `DATABASE_URL`/`TEST_DATABASE_URL`, no Meta WABA token/app-secret/verify-token, no `SUPABASE_AUTH_*` triple, and no backup/restore evidence references. Only `.env.example` (all secret values blank) exists; no `.env` is present. Re-run steps 2-4 of the Gate A pilot once a dedicated pilot database and Meta staging tenant are supplied.
- [~] Retention/legal-hold/redacted operator views are implemented, but tenant deletion/export, key rotation, and formal privacy evidence remain open.
- [ ] The explicit multi-tenant registry marker asserts deployment coverage but does not yet health-check actual tenant coverage.
- [ ] `docs/README.md` contains unrelated working-tree changes and must not be staged accidentally. (Still unstaged as of `c3b9e04`; deliberately excluded from every Gate A commit.)
- [!] Do NOT point `TEST_DATABASE_URL` at an existing production/staging project. The integration suites run `DROP SCHEMA public CASCADE` before applying migrations. The only Supabase project reachable from this environment hosts an unrelated application (PPDB school admissions) with live rows; it was deliberately not touched. Provision a dedicated, disposable pilot database first.

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

- [x] Define a tenant-scoped `AppointmentRepository` read port.
- [x] Persist `appointment_id` in the reschedule session.
- [x] Persist the source appointment version or `updated_at` fingerprint.
- [x] Define `CalendarPort.reschedule_appointment(...)` with an explicit idempotency key.
- [x] Validate appointment ownership before any mutation.
- [x] Validate the source appointment is in a reschedulable state.
- [x] Validate the target hold belongs to the same tenant and target slot.
- [x] Atomically replace the old appointment and confirm the new slot.
- [x] Preserve the old appointment if any part of the operation fails.
- [x] Return a stable domain result only after the calendar transaction commits.
- [x] Emit an audit event for accepted, rejected, expired, and conflicted operations.
- [x] Never infer an appointment ID from untrusted free text.
- [x] Require the explicit `confirm_move` action for the state-changing write.

### Required tests

- [x] Successful reschedule with one calendar mutation.
- [x] Wrong-tenant appointment is rejected before calendar access.
- [x] Missing appointment is rejected safely.
- [x] Stale appointment version is rejected.
- [x] Expired target hold is rejected or re-offered.
- [x] Target slot becomes unavailable.
- [~] Concurrent reschedule attempts cannot double-move an appointment (local contract and SQL integration fixture; live DB evidence pending).
- [x] Retry after an ambiguous commit is idempotent.
- [x] Failure leaves the original appointment unchanged.
- [x] Duplicate confirmation does not create a second appointment.
- [x] Confirmed cancellation is never silently treated as a reschedule.

**Done evidence:** API/port contract, migration, unit tests, integration test, audit-event example, and runbook.

## P0.2 Durable calendar and hold persistence

- [x] Replace the process-local default calendar state in production composition.
- [x] Define a durable calendar writer backed by Postgres or an approved provider.
- [x] Persist appointment and hold ownership in the tenant scope.
- [x] Make hold acquisition idempotent by `(tenant_id, slot_id, operation_key)`.
- [x] Make hold confirmation idempotent by `(tenant_id, hold_id, operation_key)`.
- [x] Make hold release idempotent.
- [x] Enforce one active writer for a slot/resource.
- [x] Add stale hold recovery and lease/claim fencing where required.
- [x] Define conflict behavior when provider availability changes during confirmation.
- [x] Add provider error classification and bounded retry rules.
- [x] Keep display names and provider IDs separate from stable identifiers.
- [~] Add reconciliation for calendar writes that time out after provider acceptance (Postgres operation replay exists; Google/provider reconciliation is still open).

**Done evidence:** Durable adapter tests, database constraints/indexes, provider contract tests, and an operational recovery runbook.

## P0.3 Inbound reconciliation and orphan repair

> Implementation: `apps/appointment-agent/src/ingress/` (`reconciliation.ts`,
> `reconciliation_store.ts`, `repair_audit.ts`, `reconciliation_runner.ts`), migration
> `packages/db/migrations/0014_inbound_reconciliation.sql`, tests
> `test/ingress_reconciliation*.test.ts` + `test/ingress_repair_audit.test.ts`.
> Automated evidence: appointment-agent typecheck and unit suite green; 11
> Postgres-integration tests skip without `TEST_DATABASE_URL`. A production-like
> live-DB reconciliation run remains open.

- [x] Add a durable ingress status ledger or equivalent state machine.
- [x] Distinguish `accepted`, `duplicate`, `reconciling`, `needs_repair`, and `failed` states.
- [x] Detect claims without a complete active job.
- [x] Detect jobs without the required retained inbound row.
- [x] Detect rows left between external provider acceptance and local commit.
- [x] Provide an explicit repair/quarantine command; never delete claims automatically.
- [x] Record repair actor, reason, timestamp, and resulting state.
- [x] Alert when repair age exceeds the operational threshold.
- [x] Add a scheduled reconciliation job with bounded batches.
- [x] Add a dead-letter path for messages that cannot be repaired safely.
- [x] Define customer-support behavior for messages that require manual replay.

**Done evidence:** Reconciliation queries, repair runbook, alert, and a migration/integration fixture for active and terminal orphan cases.

## P0.4 Outbound idempotency and delivery ledger

- [x] Add a durable outbound idempotency ledger keyed by tenant, provider, and operation.
- [x] Persist lifecycle states: `pending`, `sending`, `sent`, `delivered`, `read`, `failed`, `unknown`.
- [x] Store provider message ID and safe provider response code only.
- [x] Never persist plaintext recipient, message content, or access token in the ledger.
- [x] Make retries safe after process restart.
- [x] Handle partial success when one job produces multiple drafts.
- [x] Add reconciliation for `sending` records left by a crashed worker.
- [x] Add delivery-status webhook ingestion and signature validation.
- [x] Define retry limits and terminal failure handling.
- [~] Add operator replay that requires an explicit audited action (authorization/audit boundary exists; provider-specific replay adapter remains open).

**Done evidence:** Schema, adapter tests, delivery-status contract, replay tests, and provider failure runbook.

## P0.5 Database, RLS, and migration production gate

- [~] Apply migrations `0001`–`0013` to a production-like Supabase/Postgres environment.
- [~] Verify migration ordering and rerun behavior.
- [~] Verify `0001`-`0013` schema checks and constraints with real PostgreSQL.
- [~] Build a role matrix for `anon`, `authenticated`, `service_role`, migration role, and read-only analytics role.
- [~] Test RLS allow/deny behavior for every tenant-owned table.
- [~] Test cross-tenant reads and writes for all business entities.
- [x] Verify `processed_messages` remains server-only.
- [x] Verify sequence privileges for service-role writes.
- [x] Verify TLS is required for all non-local connections through `db:gate`.
- [x] Verify connection, statement, and transaction timeout settings through `db:gate`.
- [~] Verify pool exhaustion behavior.
- [~] Test backup creation and point-in-time restore; external evidence is required.
- [~] Commit a reproducible database integration test to CI.
- [x] Document migration preflight and rollback/recovery procedures.

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

Local fixture note: the offline fixtures and the local-chat harness now match Meta's
documented payload shape, where `phone_number_id` exists only at
`entry[].changes[].value.metadata.phone_number_id`. They previously also wrote a
top-level `value.phone_number_id`, which masked an ingress tenant-resolution defect
that read the field from the wrong location; real deliveries returned HTTP 200 with
no error while queuing nothing. Regression tests now pin the documented shape and
assert the top-level field is absent.

Still outstanding for P0.8: the live-Meta smoke. Signed inbound text/button/duplicate/
handoff callbacks, an outbound reply, and delivery-status callback verification
against a real WABA are still required evidence; no automated test performs a live
Meta call.

**Done evidence:** Approved template IDs, live smoke-test record, provider test evidence, and support runbook.

---

# P1 — Pilot reliability and operations

## P1.1 Observability and service levels

- [~] Add OpenTelemetry-compatible trace/correlation hooks across HTTP, ingress, worker, calendar, and outbound boundaries.
- [x] Propagate correlation IDs without raw message content.
- [~] Add Langfuse traces for graph/turn decisions with PII filtering.
- [x] Define metrics for HTTP latency, worker outcomes, outbound results, and rate-limit/outbox signals; queue/DB/purge gauges still need production collectors.
- [x] Define executable SLOs and error-budget evaluation in `src/observability/slo.ts`.
- [x] Define paging thresholds and alert evaluation in `src/observability/slo.ts`.
- [ ] Build external operational dashboards and connect alert delivery/deduplication.

**Done evidence:** Dashboard links, SLO document, alert tests, and on-call runbook.

## P1.2 Reliability and failure testing

- [~] Load-test webhook ingress (bounded concurrent smoke in `test/reliability.test.ts`; target-volume run remains open).
- [~] Load-test worker claims and processing (bounded failure/abort smoke; target-volume run remains open).
- [x] Test same-tenant concurrent messages.
- [x] Test concurrent reschedules for one appointment.
- [x] Inject database latency and pool exhaustion (fail-closed limiter double; live pool fault injection remains open).
- [x] Inject provider timeout and provider success-after-timeout (unknown ledger fencing test; provider-specific live exercise remains open).
- [~] Kill workers before and after each transaction boundary (fault-injection harness remains open).
- [~] Kill workers after calendar acceptance and before session commit (fault-injection harness remains open).
- [x] Kill workers after sender acceptance and before delivery-status persistence (unknown lease fencing contract).
- [x] Test retry storms and backoff.
- [x] Test graceful shutdown and job lease recovery.
- [~] Run a chaos exercise with a documented result (deterministic smoke exists; production exercise remains open).

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

- [x] Write ingress outage runbook.
- [x] Write queue backlog runbook.
- [x] Write orphan-claim repair runbook.
- [x] Write calendar provider outage runbook.
- [x] Write Meta outage/rate-limit runbook.
- [x] Write key-compromise runbook.
- [x] Write data-deletion incident runbook.
- [~] Define incident severity levels and communications roles in the runbook.
- [~] Create postmortem template and schedule reviews.
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

- [x] Select enterprise identity provider (owner decision, Sept 2026): Supabase Auth as OIDC provider and Google as a second provider with optional Workspace domain restriction; both are configured and both fail closed when incomplete).
- [x] Implement an RS256 OIDC JWT verifier with issuer/audience/JWKS/session/MFA validation.
- [x] Implement MFA claims and least-privilege RBAC for owner/admin/operator/support/analyst/developer.
- [~] Implement user lifecycle: invite, activate, suspend, revoke. The state machine and `is_active_user` gate session establishment, but the membership source is configuration-backed rather than a durable user store.
- [ ] Implement organization → tenant → location hierarchy.
- [x] Add API boundary with tenant membership and privileged-action MFA checks.
- [ ] Add API keys with explicit scopes and expiry.
- [x] Add session revocation and device history (verified: revocation actually revokes, only a hash of the cookie secret is stored, and the logout route revokes server-side).
- [x] Add privileged-action audit contract for destructive operations.
- [ ] Add access-review reporting.

**Done evidence:** IAM design, role matrix, SSO tests, and access-review procedure.

## P2.2 Operator workspace

- [x] Define handoff queue and tenant-safe operator action boundary.
- [x] Add redacted operator context and PII-minimized audit timeline.
- [x] Add authorized reschedule/cancel/replay action contracts.
- [x] Build conflict resolution UI/state.
- [x] Add assignment and escalation workflow.
- [x] Add SLA timers.
- [x] Add manual replay authorization/audit contract; provider adapter remains open.
- [x] Add role-based access checks to every operator mutation.
- [x] Add accessibility and keyboard/screen-reader coverage for the UI.

**Done evidence:** Operator design, permission tests, accessibility audit, and support workflow.

The UI half of P2.2 landed in `apps/dashboard` as a Next.js App Router application. It drives the
already-audited domain contracts rather than a parallel model: conflict transitions call
`conflict_resolution.ts`, the queue calls `operator_queue.ts` (including the escalation cap and SLA
breach rule), operator actions call `operator_actions.ts` behind the real authorization preflight, and
every principal is validated by `authorization.ts`. The action surface mirrors the existing
`POST /v1/operator/actions` request shape but is served by a clearly marked local in-memory fixture and
audit adapter; there is no HTTP or database wiring yet.

Verified evidence: `pnpm typecheck` and `pnpm test` green monorepo-wide (dashboard 193 tests across 13
files; appointment-agent 613 tests unchanged). `pnpm --filter @repo/dashboard build` prerenders all six
routes, and `next dev -H 127.0.0.1` serves `/`, `/appointments`, `/conflicts`, `/queue`, `/actions`,
and `/audit` with HTTP 200 on loopback. `test/conflict_board.test.ts` and
`test/operator_queue_board.test.ts` cover every legal and illegal transition; `test/accessibility.test.tsx`
asserts zero axe-core violations on all five views plus the skip link, `h1`, `aria-sort`, landmark, and
disabled-reason contracts; `test/keyboard_navigation.test.tsx` covers tab order, keyboard-only
completion, and focus management; `test/redaction.test.tsx` asserts no customer content reaches any
payload or rendered surface; `test/appointments_view.test.ts` and `test/fixtures.test.ts` prove foreign
tenant rows are filtered and counted.

**Not done and deliberately so:** the interface is **no longer unauthenticated** — staff sign in through an OAuth authorization-code flow (Supabase Auth or Google), the workspace refuses to render without a verified session, and every operator mutation is authorized on the server against the session-derived principal. What is still missing is server-owned data: operator actions execute in the browser against a local in-memory fixture and audit adapter, so the row-level security and durable audit ledger that RB-12 assumes do not exist yet. Per the P2 audit the dev and start scripts therefore still pin the bind to `127.0.0.1`, and nothing in `next.config.mjs` may add a `0.0.0.0` bind, a public `hostname`, or a tunnel. That constraint is authentication-independent: it is released by moving action execution and data ownership to the server, not by adding a login. The domain gap noted earlier still stands: `OperatorActionService.execute` calls `normalize_request` outside its audited try/catch, so a malformed request produces no audit row. The UI cannot construct one because reason codes are a bounded select rather than free text.

**Staff sign-in evidence (Sept 2026).** One authorization-code implementation in `apps/appointment-agent/src/enterprise/oauth/` serves both staff login and Calendar consent: a cryptographically random single-use `state` bound to purpose, provider, tenant, and an allow-listed return path and stored hashed; PKCE S256 on both flows; `nonce` validated against the ID token; and a `redirect_uri` allow-list that refuses rather than reflects. Sessions are `HttpOnly`, `SameSite=Lax`, `Secure` with a `__Host-` prefix outside the explicit loopback opt-in, short-lived, rotated per login, and revocable through the existing `session_registry` contract; only a SHA-256 hash of the cookie secret is stored. MFA is derived from `aal2` or a recognised `amr` entry and is never asserted by the client — the previous synthetic principal that hard-coded `has_mfa: true` is deleted, and privileged actions now fail closed without verified MFA. Google Calendar refresh tokens are encrypted at rest with the existing overlap key ring, bound per tenant and purpose so a copied row fails to decrypt, mapped to the authorizing staff subject and the provider's opaque account id, and revocable on both sides.

Verified evidence: `pnpm typecheck` and `pnpm build` green monorepo-wide (21/21 and 12/12); `pnpm test` green (20/20 tasks; appointment-agent 777 passing across 88 files, dashboard 287 across 20, `@repo/mcp-gcal` 19). `test/enterprise_oauth_state.test.ts` covers missing, malformed, forged, expired, and replayed state plus purpose/provider/tenant binding; `test/enterprise_oauth_redirect.test.ts` covers the allow-list, prefix-confusion, and traversal refusals; `test/enterprise_staff_session.test.ts` covers cookie attributes, revocation actually revoking, and the MFA-gated privileged action failing closed; `test/enterprise_staff_auth_flow.test.ts` runs a full authorize → callback → session → authorized round trip against a local fake IdP that signs real RS256 ID tokens, serves a real JWKS, and enforces PKCE by recomputing the challenge; `test/enterprise_google_token_grants.test.ts` asserts the plaintext refresh token is absent from stored rows, that cross-tenant decryption fails, and that the audit sink carries no token, subject, or email. A live `next start` run confirms unauthenticated `/` and `/actions` render only the sign-in notice with no tenant id, fixture row, or navigation; that `/auth/login` emits a Supabase authorize redirect carrying `state`, `code_challenge_method=S256`, and `nonce` with no client secret; that callbacks with no, forged, or malformed state are refused with distinct sanitized codes; that Calendar consent without a session is `401`; that an unsupported provider is `400`; that a cross-origin logout is `403`; and that with no provider configured `/auth/login` is `503`.

**Not yet evidenced:** the full round trip was exercised in-process against a local fake IdP over real RS256/JWKS/PKCE rather than against a live HTTPS IdP, because the verifier is HTTPS-only and this environment has no Supabase project, Google client credentials, or local TLS material. Session, state, and grant stores are in-memory and therefore single-process; a multi-instance deployment must inject shared adapters.

## P2.3 Enterprise APIs and integrations

- [x] Publish a versioned operator API boundary at `/v1/operator/actions`.
- [ ] Add authenticated webhooks for appointment changes.
- [ ] Sign outbound webhooks.
- [x] Define webhook replay and idempotency semantics in the durable ledger/session contracts.
- [x] Add tenant-aware API/provider rate limits.
- [ ] Add API key rotation and revocation.
- [~] Complete Google Calendar OAuth and production consent flow (authorize → callback → PKCE-verified exchange → encrypted per-tenant refresh-token store → reuse through the existing `mcp-gcal` client; not yet exercised against a live Google project, and the grant store is in-memory).
- [x] Add provider-specific error contracts for WhatsApp transport and durable ledger.
- [ ] Select and implement the first PMS/CRM adapter only after the core contract is stable.
- [x] Add contract tests for core external adapters.

**Done evidence:** OpenAPI/event contracts, adapter test suite, and integration runbooks.

## P2.4 Compliance and governance

- [~] Complete threat model and data-flow diagram (code boundaries and SLO/ledger runbooks updated; formal review remains open).
- [ ] Complete privacy impact assessment.
- [ ] Publish privacy policy and data-processing terms.
- [ ] Maintain subprocessor inventory.
- [ ] Define data residency requirements.
- [x] Define retention, legal-hold, redaction, and bounded purge behavior.
- [x] Define append-only operator audit export boundary.
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

- [~] Define traffic model per tenant and per location (`src/enterprise/capacity.ts` contract; product targets remain open).
- [x] Define bounded peak webhook, worker, database, and provider capacity limits.
- [~] Load-test at target volume plus agreed headroom (deterministic smoke exists; target-volume run remains open).
- [x] Define pool, queue, database, and provider capacity limits.
- [x] Add per-tenant rate limits and fairness controls.
- [ ] Track cost per appointment and per message.
- [ ] Add budget alerts for WhatsApp, LLM, database, and observability spend.
- [ ] Define cost allocation and chargeback/reporting requirements.
- [~] Optimize expensive provider calls without weakening confirmation/idempotency boundaries.

## P3.2 Resilience and regional operations

- [~] Decide whether multi-region availability is required by contract.
- [x] Define RPO/RTO validation and rebuild order in `src/enterprise/disaster_recovery.ts`.
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

- [x] Atomic old-appointment reschedule is implemented and tested. (`src/calendar/`, `src/reschedule/`, `src/appointments/`, migration `0012`; unit + migration-contract coverage green.)
- [x] Durable calendar writer is used in the pilot composition. (`PostgresCalendarWriter` selected by `build_composition` whenever `DATABASE_URL` is set; `composition.test.ts` green.)
- [x] No P0 security or correctness findings remain. (Inline review of the Gate A delta found no Critical/High issue: tenant-bound recipient decryption, reschedule tenant+version checks, calendar operation-key fingerprint conflict, outbound `unknown` fencing, operator authorize-before-side-effect, and server-only RLS/grants on `0012`/`0013` tables all verified. No credentials or PII reach logs, metrics labels, or fixtures.)
- [~] Ingress and outbound reconciliation are active. (Runners exist and are wired; scheduling in the pilot process is not yet enabled.)
- [ ] Production-like Postgres/RLS/TLS verification passes. (Blocked: no `DATABASE_URL`; `db:gate` verified fail-closed at exit 2.)
- [ ] Backup restore has been rehearsed. (Blocked: no database target and no recovery-evidence references.)
- [ ] Meta WABA and utility template are approved. (Blocked: no Meta credentials in this environment.)
- [ ] Signed webhook-to-reply smoke test passes. (Blocked: `smoke:meta` verified fail-closed at exit 2 without a staging target.)
- [ ] Load and failure tests meet the agreed pilot threshold. (Capacity/traffic contracts are executable, but no agreed numeric pilot threshold has been measured against a live database.)
- [x] On-call runbooks and alerts exist. (`docs/06-Appendix/J-Runbooks.md`; SLO and alert evaluation covered by executable tests.)
- [ ] Pilot support and rollback procedures are approved. (Requires owner sign-off.)

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

# Residual risk — Gate A pilot attempt (1 October 2026)

**Outcome:** code-complete and locally green; the pilot could not be driven to GREEN because no pilot credentials exist in this environment. Nothing below is inferred or assumed — each item is an observed blocker.

## Verified this run

- Monorepo `pnpm typecheck` 14/14 and `pnpm test` 14/14 green at `739d8e5`; appointment-agent 78 files passed / 2 skipped, 613 tests passed / 21 skipped.
- Fixed a real regression inherited from the previous baseline: `e9461c4` was **red** (2 files, 10 tests failing) because the worker and reschedule session store read the wall clock, so the 24-hour service-window and session-expiry assertions broke once the fixtures aged past. Both now take an injected clock.
- Gate A WIP is committed as four atomic conventional commits (`c20ba64`, `739d8e5`, `6934eca`, `c3b9e04`), each independently typechecked and suite-verified in a detached worktree.
- All three operational gates fail closed with no credentials and leak no secret material: `db:gate` and `db:restore-rehearsal` exit 2 (`*_blocked`), `smoke:meta` exits 2 (`meta_staging_smoke_blocked`).

## Blocked on absent credentials (owner action required)

1. **Pilot database.** No `DATABASE_URL` or `TEST_DATABASE_URL`. Migrations 0001-0014 were therefore never applied, the 21 integration tests never ran with a database, and `db:gate` produced no schema/RLS/role/TLS/timeout evidence. Needs a dedicated disposable pilot Postgres.
2. **Backup / point-in-time restore rehearsal.** Not performed. No recovery-evidence references exist, so `db:gate` cannot pass its `backup` and `restore` checks even once a database is supplied. Needs a real backup plus a recorded restore.
3. **Live Meta.** No WABA, phone-number id, app secret, verify token, approved utility template, or test recipient. WABA verification, signed webhook smoke, one live outbound reply, delivery-status round-trip, token-scope review, and provider error/rate-limit/timeout/revoked-token behavior are all unexercised.
4. **Identity provider.** No `SUPABASE_AUTH_*` triple, so the operator API verifier cannot be exercised against a real issuer.

## Accepted risks / judgement calls

- The integration suites run `DROP SCHEMA public CASCADE` and `CREATE ROLE`; they are destructive by design and must only ever target a disposable database. The single Supabase project reachable from this environment runs an unrelated application with live rows, so it was deliberately left untouched rather than reused.
- No local PostgreSQL is usable here (PostgreSQL 18 install has no binaries, Docker daemon cannot start without elevation, WSL2 virtualization is disabled), so no substitute production-like target was available.
- P3 cost, capacity, regional, and analytics contracts are committed and unit-tested but are not yet consumed by any runtime wiring; they are contracts, not behavior.

## Not verified by this run

- Anything requiring a live database, a live Meta tenant, or a real identity provider (see above).
- Load and failure thresholds: no agreed numeric pilot threshold has been measured.

