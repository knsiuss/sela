# appointment-agent (MVP scaffold)

LangGraph TypeScript state machine for the Sela reschedule agent. It maps to
`docs/05-Execution/02-MVP-Scope.md`.

## Flow

`parse` (intent + handoff gates) → `offer` (three slots) → `hold` (timed
slot hold) → `confirm` (human-in-the-loop `interrupt` before the irreversible
write) → `write` (idempotent calendar write).

The app depends on `@repo/slot-engine` through `SlotServiceAdapter`. The adapter
maps app slots and holds to the package's tenant-scoped `SlotService` and
translates package errors at the boundary. `InMemoryCalendar` is a test helper
only and is not the runtime default.

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
`WHATSAPP_PHONE_NUMBER_ID`. Explicit in-memory mode creates an ephemeral
recipient-encryption key at startup, so its encrypted rows cannot survive a
restart; it is not a production key-management mode. On PowerShell, set the
secrets with
`$env:WHATSAPP_VERIFY_TOKEN="..."` and `$env:WHATSAPP_APP_SECRET="..."` before
running `pnpm start`.

The server exposes `GET /healthz`, Meta verification on
`GET /webhooks/whatsapp`, and signed deliveries on `POST /webhooks/whatsapp`.
Responses are marked `Cache-Control: no-store`; the POST body is limited to
`MAX_WEBHOOK_BYTES` and the HTTP route has a bounded response deadline below
the 3-second ACK SLO.

## Tenant-aware ingress and worker

Apply `packages/db/migrations/0005_inbound_messages.sql`,
`0006_reply_target.sql`, `0007_inbound_button_id.sql`,
`0008_worker_tenant_hardening.sql`, `0009_worker_leases.sql`, and
`0010_reschedule_sessions.sql` after `0004_webhook_jobs.sql` before enabling
multi-turn rescheduling in a database-backed deployment.

`DATABASE_URL` selects the Postgres composition and must use a dedicated
server-side role with the migration-defined `service_role` grants. The pool
uses bounded statement and connection timeouts (`PG_STATEMENT_TIMEOUT_MS` and
`PG_CONNECTION_TIMEOUT_MS`). Database-backed mode also requires
`WHATSAPP_RECIPIENT_ENCRYPTION_KEY_BASE64`, containing exactly 32 random bytes
encoded as canonical base64. Keep that key stable for the lifetime of retained
rows and load it from the deployment secret manager; never reuse the Meta access
token as this key. `USE_IN_MEMORY=true` is an explicit local/test fallback only;
it is mutually exclusive with `DATABASE_URL`, and without either setting startup
fails rather than silently using process memory. `APP_MODE=server` starts the HTTP server
and worker, while `APP_MODE=worker` starts only the worker. `SIGTERM` and
`SIGINT` stop the worker, close the server, and close the pg pool.

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
confined to the separately retained `inbound_messages` table. The default
composition builds `WhatsAppSenderAdapter` from `@repo/wa-sender`; explicit
`USE_IN_MEMORY=true` selects its non-network `InMemoryTransport`, while
`WHATSAPP_TRANSPORT=meta` requires `WHATSAPP_API_TOKEN` and
`WHATSAPP_PHONE_NUMBER_ID`. Tests may inject an `OutboundSenderPort` directly.
Delivery leaves the explicit app key unset and lets `WhatsAppSender` derive a
bounded key from the stable inbound WAMID and turn ordinal. The sender's
idempotency coordinator remains process-local; a durable cross-process
idempotency adapter is still a follow-up. The adapter also rejects
state-changing drafts until a durable tenant- and hold-bound confirmation
evidence port is available.

Set `TENANT_ID` for a non-default runtime tenant. The CLI uses a single
in-process package service for the local scaffold. The default composition
caches one `SlotServiceAdapter` per tenant only inside that worker process, so
a hold survives separate local jobs but is not durable across processes.
Production calendar persistence/provider integration remains outside this
cutover. Runtime slots use opaque staff/provider ids; `resource` retains the
display label.

The cross-tenant CLI path defaults to `CROSS_TENANT_CONSENT_GRANTED=false`
and `CROSS_TENANT_AUTHZ_GRANTED=false`, with an empty in-memory provider. The
latter is only a local scaffold switch; it is not production authentication.
`CROSS_TENANT_VERTICAL` and `CROSS_TENANT_LOCALE` may set the requested
dimensions, but no partner availability is loaded until an authenticated
conversation authorizes it and a consented provider is wired in code.

### Tests and typecheck

```bash
pnpm --filter appointment-agent typecheck
pnpm --filter appointment-agent test
```

The worker and ingress tests use injected SQL/pool doubles; no live database or
Meta call is made by the test suite.

### Production blockers still open

This hardening pass does not make the database-backed worker pilot-ready yet. Before production enablement, the repository still needs:

- an atomic ingress transaction/outbox and durable reconciliation;
- a durable tenant-scoped calendar writer (the current default is local scaffold);
- an atomic reschedule contract that replaces the existing appointment; the current flow confirms a selected hold but has no old appointment target;
- tenant-specific Meta credentials and a durable outbound idempotency/status ledger;
- live Postgres/Supabase RLS, role, and TLS verification.

Meta transport and customer-service-window behavior follow the official
Cloud API documentation: https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages
