# appointment-agent (MVP scaffold)

LangGraph TypeScript state machine for the Sela reschedule agent. It maps to
`docs/05-Execution/02-MVP-Scope.md`.

## Flow

`parse` (intent + handoff gates) → `offer` (three slots) → `hold` (timed
slot hold) → `confirm` (human-in-the-loop `interrupt` before the irreversible
write) → `write` (idempotent calendar write).

The local CLI still uses `@repo/slot-engine` through `SlotServiceAdapter`.
Database-backed runtime instead uses `PostgresCalendarWriter`: v2 holds own a
held appointment row, tenant operation ledger, optimistic appointment version,
and an atomic old-appointment-to-target-hold transaction. The Google Calendar
adapter remains a provider adapter and fails closed for atomic reschedule
because provider metadata cannot replace the local source appointment safely.

The app TTL policy reads `HOLD_TTL_SECONDS`, defaults to 300 seconds, and
clamps requests to the package maximum of 600 seconds.

## Voice-note reschedule boundary

`src/voice_note_flow.ts` handles transcript text through
`handle_voice_note()`. A complete proposal emits the `@repo/voice-intent`
consent card and returns `await_confirmation`; it has no calendar dependency
and cannot hold or write a slot. Missing or conflicting date/time fields return
one clarification question, while `batal` returns the `cancel` route for the
existing cancellation flow. Speech-to-text, text-to-speech, audio upload, and
queue processing are deliberately outside this boundary. The local scaffold can
exercise the transcript path with `pnpm dev -- --voice-note "besok sore"`.

## Cross-tenant concierge pilot

`src/cross_tenant_search.ts` is a partial integration for a customer request such
as “cari slot minggu ini di klinik terdekat”. It calls the read-only
`@repo/slot-broker` search and returns consent-card offers only.

This path is intentionally concierge-grade, not an autonomous booking path:

- The handler requires an injected authorization decision; a non-`true` result
  fails closed before consent or provider work.
- `consent_granted !== true` returns an opt-in clarification without querying
  any partner tenant.
- A partner must have both sharing consent and an active partner contract; the
  requester tenant and vertical/locale mismatches are excluded with audit
  reasons.
- Fairness is deterministic FCFS by availability `created_at`, with documented
  `tenant_id` then `slot_id` tie-breaking and no LLM in the policy.
- Offers are not bookings. They remain `pending_human_approval`, and the normal
  calendar writer is not called by this node.

The CLI path uses an empty in-memory provider so a local run cannot broadcast
availability. A pilot deployment must inject a tenant-scoped, consented
provider, add provider timeouts/rate limits, authenticate the requester, and
connect a separately audited human approval and single-writer booking flow.
Production use remains blocked until those controls, partner agreements, and
privacy review are complete.

## Run

The default `APP_MODE=cli` preserves the local message flow:

```bash
pnpm install
pnpm test
pnpm dev -- "I would like to reschedule to Thursday afternoon, can I?"
pnpm dev -- --voice-note "besok sore"
```

To run the Node HTTP ingress instead, provide the verification token and app
secret from the environment and use the server start script:

```bash
pnpm start
```

`pnpm dev` and direct `tsx src/index.ts` keep the default `APP_MODE=cli`; the
start wrapper selects `server` mode. `APP_MODE=server` starts the HTTP server
and worker, while `APP_MODE=worker` starts only the worker. For a local
server-only smoke run without Postgres, set `USE_IN_MEMORY=true` and provide
`WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, and
`WHATSAPP_PHONE_NUMBER_ID`. The in-memory worker uses one non-network sender
for tenant `1` by default; set `TENANT_ID` to bind that local sender to a
different single tenant. Explicit in-memory mode creates an ephemeral
recipient-encryption key at startup, so its encrypted rows cannot survive a
restart; it is not a production key-management mode. On PowerShell, set the
secrets with
`$env:WHATSAPP_VERIFY_TOKEN="..."` and `$env:WHATSAPP_APP_SECRET="..."` before
running `pnpm start`.

The server exposes `GET /healthz`, bounded Prometheus text on `GET /metrics`, Meta verification on
`GET /webhooks/whatsapp`, and signed deliveries on `POST /webhooks/whatsapp`.
An optional versioned operator action endpoint is available at
`POST /v1/operator/actions` only when an OIDC verifier and operator action
service are injected; it fails closed without them. Responses are marked
`Cache-Control: no-store`; the POST body is limited to `MAX_WEBHOOK_BYTES` and
the HTTP route has a bounded response deadline below the 3-second ACK SLO.

## Tenant-aware ingress and worker

Apply `packages/db/migrations/0005_inbound_messages.sql`,
`0006_reply_target.sql`, `0007_inbound_button_id.sql`,
`0008_worker_tenant_hardening.sql`, `0009_worker_leases.sql`,
`0010_reschedule_sessions.sql`, `0011_tenant_scoped_dedupe.sql`,
`0012_durable_calendar_reschedule.sql`, and
`0013_rate_limit_outbound_ledger.sql` after `0004_webhook_jobs.sql` before
enabling multi-turn rescheduling and atomic ingress in a database-backed
deployment. Migration `0011` intentionally stops
if legacy `processed_messages` claims cannot be reconciled to a real tenant;
never delete dedupe claims to force the key change. Migration `0013` adds the
server-only tenant rate-limit windows, PII-minimal outbound ledger, legal-hold
controls, and append-only operator-action evidence.

`DATABASE_URL` selects the Postgres composition and must use a dedicated
server-side role with the migration-defined `service_role` grants. The pool
uses bounded statement and connection timeouts (`PG_STATEMENT_TIMEOUT_MS` and
`PG_CONNECTION_TIMEOUT_MS`). Database-backed mode also requires
`WHATSAPP_RECIPIENT_ENCRYPTION_KEY_BASE64`, containing exactly 32 random bytes
encoded as canonical base64. Keep that key stable for the lifetime of retained
rows and load it from the deployment secret manager; never reuse the Meta access
token as this key. Database-backed mode also requires `CALENDAR_SLOTS_JSON`
with 1–500 bounded slots. Every slot must carry `resource_id`, matching an
existing `resources.id` for the tenant; the durable writer rejects an unbound
slot rather than falling back to process-local state. `USE_IN_MEMORY=true` is
an explicit local/test fallback only;
it is mutually exclusive with `DATABASE_URL`, and without either setting startup
fails rather than silently using process memory. `APP_MODE=server` starts the HTTP server
and worker, while `APP_MODE=worker` starts only the worker. `SIGTERM` and
`SIGINT` stop the worker, close the server, and close the pg pool.

The default database composition also scopes the worker claimer to `TENANT_ID`;
it cannot claim another tenant's jobs. A composition using an injected
multi-tenant `OutboundSenderRegistry` may omit `TENANT_ID` and use the global
claimer only when it is marked with `mark_multi_tenant_sender_registry` and
explicitly covers every tenant that can enqueue work. An existing dedupe claim without a complete
worker job or active inbound row fails closed as an orphan for operator
reconciliation; terminal jobs may remain valid after inbound retention cleanup.
The HTTP ACK deadline aborts in-flight tenant resolution and atomic transaction
work, releasing or destroying the dedicated database connection.

Every Meta `phone_number_id` must have a row in `tenant_channels`:

```sql
INSERT INTO public.tenant_channels (tenant_id, channel, channel_account_id)
VALUES (42, 'whatsapp', '123456789012345')
ON CONFLICT (channel, channel_account_id) DO UPDATE
SET tenant_id = EXCLUDED.tenant_id;
```

Ingress resolves that mapping before enqueueing. An unknown channel is counted
as `unresolved_count`, receives no job, and still returns HTTP 200. Known
messages are stored in `inbound_messages` before the PII-free `webhook_jobs`
row is enqueued. The transient Meta `from` phone is encrypted with AES-256-GCM
before persistence; neither plaintext nor ciphertext is copied into the job,
graph state, logs, or audit events. The worker loads by `(tenant_id, wamid)`,
decrypts the reply target only while constructing the outbound draft, invokes
the graph, delivers the outbound drafts, then marks the inbound row processed
and completes the job. A delivery failure leaves the inbound row unprocessed
and uses bounded exponential `available_at` retries; `WORKER_MAX_ATTEMPTS`
controls the terminal failure boundary. Inbound `button_id` values are routed
only when they exactly match the current tenant/conversation offer generation.
The session store retains bounded slot/phase state but never raw message text,
sender references, or recipients. Replies older than the 24-hour customer
service window are skipped until an approved template path is wired.

The default retention is 30 days and can be changed with
`INBOUND_MESSAGE_RETENTION_DAYS`. Run retention cleanup as the server-side
`service_role` (or an explicitly tenant-scoped maintenance transaction):

```sql
DELETE FROM public.inbound_messages
WHERE expires_at <= now();
```

Rows created before migration `0006` have a null encrypted reply target and
cannot be replied to. Expire them under the retention policy or obtain a new
signed webhook delivery and reprocess it; the worker fails closed instead of
sending to a reconstructed or stale destination.

`webhook_jobs` contains only identifiers, status, retry metadata, and tenant
routing. Message text, sender references, and the encrypted reply target are
confined to the separately retained `inbound_messages` table. The worker
selects outbound delivery through an `OutboundSenderRegistry` that receives
both the claimed job's `tenant_id` and one `OutboundDraft`; it never chooses a
provider from a process-global token. `WhatsAppSenderAdapter` remains the
per-sender implementation. Explicit `USE_IN_MEMORY=true` selects the
non-network `InMemoryTransport` and binds it to the configured local tenant.
A database-backed default without an injected registry requires `TENANT_ID`
plus `WHATSAPP_API_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID`; it fails closed for
every other tenant. Multi-tenant deployments must inject a secret-backed
`OutboundSenderRegistry` through `CompositionOptions.sender_registry`, which
can resolve an explicit sender for each tenant and rejects missing mappings
before provider I/O. Do not put multiple credentials in a JSON environment
variable; load them through the deployment's secret manager and inject the
port. Delivery leaves the explicit app key unset and lets `WhatsAppSender`
derive a bounded key from the stable inbound WAMID and turn ordinal. The
sender's idempotency coordinator remains process-local; a durable
cross-process idempotency adapter is still a follow-up. The adapter also
rejects state-changing drafts until a durable tenant- and hold-bound
confirmation evidence port is available.

Set `TENANT_ID` for a non-default single-tenant runtime binding. The CLI uses a
single in-process package service for the local scaffold. Database-backed
composition creates one `PostgresCalendarWriter` per tenant; its holds,
operation keys, and source versions survive worker replacement. A reschedule is
offered only when a trusted server workflow has attached an `appointment_id` to
the retained inbound row. The worker never extracts that id from customer text,
and a missing, foreign, cancelled, or non-confirmed source routes to handoff.
Multi-tenant sender credentials remain a deployment concern: inject a registry
backed by the secret manager rather than reusing the pilot's global adapter.
Runtime slots use opaque `staff` provider ids, `resource` display labels, and
the required `resource_id` database identity.

The cross-tenant CLI path defaults to `CROSS_TENANT_CONSENT_GRANTED=false`
and `CROSS_TENANT_AUTHZ_GRANTED=false`, with an empty in-memory provider. The
latter is only a local scaffold switch; it is not production authentication.
`CROSS_TENANT_VERTICAL` and `CROSS_TENANT_LOCALE` may set the requested
dimensions, but no partner availability is loaded until an authenticated
conversation authorizes it and a consented provider is wired in code.

### Tenant admission, delivery evidence, and enterprise boundaries

Database-backed composition uses a Postgres fixed-window limiter keyed by
`(tenant_id, scope, window_bucket)`. The webhook limiter is applied after
channel-to-tenant resolution; the outbound limiter is applied immediately
before provider I/O. Limits are configuration, not provider assumptions, and
must be kept below the account's verified Meta throughput. A database limiter
failure is fail-closed (`503`) rather than an unbounded bypass.

Outbound delivery is claimed in `outbound_ledger` before the provider call.
The ledger stores only operation identity, safe provider ids/codes, lifecycle
timestamps, and lease state—never a recipient, message body, or access token.
A retry replays a committed `sent` result, an expired `sending` lease becomes
`unknown`, and an ambiguous provider timeout is never automatically resent.
Signed Meta `statuses` callbacks are resolved to the same tenant and applied
monotonically. Partial success across multiple drafts is safe because each
`turn_id` has an independent ledger row.

The process-local ledger/synthetic acknowledgement is available only when
`USE_IN_MEMORY=true`; production requires a provider WAMID and a Postgres
ledger. Operator actions are tenant-scoped, MFA-gated where destructive, and
written to append-only `operator_action_audit`. `OidcJwtVerifier` accepts only
RS256 tokens from an explicitly configured HTTPS issuer/JWKS endpoint.

### Reliability, recovery, and smoke commands

```bash
pnpm --filter appointment-agent typecheck
pnpm --filter appointment-agent test
pnpm --filter appointment-agent test:reliability
TEST_DATABASE_URL=postgresql://... pnpm --filter appointment-agent test:postgres
DATABASE_URL=postgresql://... pnpm --filter appointment-agent db:gate
META_SMOKE_ENVIRONMENT=staging pnpm --filter appointment-agent smoke:meta
```

`db:gate` is read-only and requires explicit TLS, backup, and restore evidence;
it does not treat a successful migration as production approval. The Meta smoke
defaults to a non-sending phone-number preflight. A template send additionally
requires `META_SMOKE_ALLOW_SEND=true`, an approved template, an explicit
recipient, and staging credentials. No automated test makes a live Meta call.

Most worker and ingress tests use injected SQL/pool doubles. The durable
calendar/ledger integration suite is enabled with `TEST_DATABASE_URL` against a
disposable PostgreSQL database with pgvector installed; it applies every
migration and exercises holds, reschedules, rollback, expiry, cross-tenant
denial, concurrent moves, idempotent replay, outbound leases/statuses, and
Postgres tenant rate counters.

### Production blockers still open

This hardening pass does not make the database-backed worker pilot-ready yet. Before production enablement, the repository still needs:

- trusted upstream workflow that attaches the existing appointment id; the database contract is fail-closed but the product source-of-truth decision remains open;
- passing production-like `TEST_DATABASE_URL` migration/calendar/ledger integration, plus the external `db:gate` evidence for RLS, roles, TLS, backup, and restore;
- reconciliation between the Postgres source of truth and Google Calendar, including provider success-after-timeout behavior;
- a secret-backed production `OutboundSenderRegistry` with per-tenant Meta credentials, rotation, and an operator-approved path for resolving `unknown` ledger rows;
- approved live Meta staging credentials/template, signed inbound/button/status smoke evidence, and delivery callback verification;
- enterprise OIDC/SAML rollout, MFA policy, operator workspace UI, penetration-test evidence, data-residency approval, and DR exercise sign-off.

Meta transport and customer-service-window behavior follow the official
Cloud API documentation: https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages
