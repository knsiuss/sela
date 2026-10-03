# J — Runbooks

> Aturan: tiap runbook punya owner, prasyarat, langkah + validasi, rollback, estimasi waktu. Review tiap kuartal. Aksesibel saat outage.

## RB-01 Deploy prod (owner: backend)

1. Prasyarat: CI hijau (`turbo build lint test --filter=[origin/main]`), migrasi `packages/db` direview, template WA approved.
2. Apply migrasi staging → smoke (liveness + 1 booking E2E). Validasi: 200 semua.
3. Promote prod → smoke sama. Validasi: liveness 200, outbox lag <60 dtk.
4. Pantau 30 mnt: webhook 5xx, queue depth, error rate.
5. Rollback: redeploy artifact sukses sebelumnya (Render/Railway); migrasi hanya down-bila-aman; matikan autoDeploy saat insiden.

## RB-02 Rollback cepat (owner: backend)

1. Identifikasi deploy buruk (alert/owner). 2. Redeploy artifact sebelumnya. 3. Verifikasi smoke. 4. Catat postmortem bila dampak customer. Estimasi: <15 mnt.

## RB-03 Restore Postgres (owner: backend)

1. Konfirmasi kebutuhan (data loss/korupsi). 2. Hentikan writer (maintenance mode). 3. Restore PITR/backup harian ke titik target. 4. Verifikasi counts + 1 booking baca. 5. Buka writer. Catatan: restore = downtime. Drill 1x/kuartal.

## RB-04 Webhook Meta down/banjir retry (owner: backend)

1. Cek liveness `:3002` + queue depth. 2. Bila API mati: restart service, verifikasi dedupe `wamid` menahan duplikat. 3. Bila banjir: scale worker, pastikan ACK <3 dtk, circuit-breaker vendor. 4. Validasi: lag kembali <60 dtk, 0 double-book.

## RB-05 Template di-pause / quality drop (owner: GTM)

1. Cek webhook `message_template_quality_update`. 2. Hentikan blast, alihkan ke template cadangan approved. 3. Revisi konten (hapus unsur promo dari utility). 4. Re-submit + catat.

## RB-06 API key/OAuth bocor (owner: security)

1. Revoke segera (Google/Meta). 2. Rotasi via Vault. 3. Cek audit log akses aneh. 4. Notifikasi sesuai playbook breach bila PII terdampak (≤72 jam).

### RB-06b Break-glass credential and recipient-key rotation (owner: security)

P0.6 evidence: per-tenant Meta credentials resolve at runtime through the secret-manager port (`TenantSenderCredentialStore` + `TenantSecretSenderRegistry`); recipient ciphertext carries key-id metadata with tenant AAD binding (`RotatingRecipientCipher`).

1. Revoke first: call `revoke_tenant(tenant_id)` (or remove the tenant mapping and restart) so the tenant fails closed before provider I/O. Process revocation lasts until restart; the durable control is rotating or disabling the credential in the secret provider. Preserve `secret_access_total{operation="revoke"}` and the audit sink events; never paste secret values into the incident record.
2. Rotate the Meta credential in the secret provider (pilot: the env-backed `EnvSecretManager` port adapter, so update the environment/secret store and restart/redeploy), then confirm a canary send for the tenant and an unmapped-tenant fail-closed check. Roll back by re-revoking; rotation applies to new sends without a restart once the managed provider replaces the env adapter.
3. Rotate a recipient key by adding the new key id to `WHATSAPP_RECIPIENT_ENCRYPTION_KEYS_JSON` with the old id retained (overlap ≤8 keys), switching `active_key_id`, and verifying old rows still open. Remove the old id only after retention expiry. Approval: security owner + on-call sign-off; record key ids (never values), timestamps, and the rotation drill result here.

## RB-07 Durable calendar/reschedule recovery (owner: backend)

1. Stop HTTP/worker writers and preserve the pre-change database backup. Do not delete `processed_messages`, `appointment_holds`, `calendar_operations`, appointments, or audit rows.
2. Apply migrations through `0012_durable_calendar_reschedule.sql`; stop if the migration reports a legacy tenant/resource mismatch. Reconcile ownership from an approved source, then rerun.
3. Verify every configured `CALENDAR_SLOTS_JSON` entry has a `resource_id` owned by the same tenant. Start one canary worker and run a disposable-tenant hold, duplicate retry, reschedule, and duplicate-confirmation smoke test.
4. For an uncertain reschedule result, look up `(tenant_id, operation_key)` in `calendar_operations`. If present, return the committed result; if absent, inspect the source appointment version and hold before any replay. Never guess or edit a result row.
5. For an expired/conflicting hold, keep the source appointment unchanged, release the hold idempotently, and re-offer. Route stale version, missing, cancelled, or cross-tenant state to operator handoff.
6. Roll back application traffic first. Leave additive migration objects in place unless a reviewed down migration proves no live writer depends on them; restore from backup if tenant ownership or key state cannot be reconciled.

## RB-08 Tenant rate limit and outbound ledger (owner: backend/SRE)

1. Check `GET /metrics` for `webhook_rate_limited_total`, `outbound_provider_sends_total{result="unknown"}`, and `outbound_provider_sends_total{result="failed"}`. Do not raise the limit during an incident without confirming the tenant's Meta throughput tier.
2. For an exhausted tenant, verify the fixed-window row in `tenant_rate_limits` and the caller's `Retry-After` response. Correct the tenant's queue/backlog or provider error first; never delete counters to reset a limit.
3. For an `unknown` outbound row, stop automatic replay. Query `outbound_ledger` by `(tenant_id, provider, operation_key)`, reconcile the provider WAMID/status callback, and require an MFA-authenticated operator action before any manual replay.
4. For a partial multi-draft job, confirm that sent rows are replayed and only the unsent row is retried. Never reconstruct a recipient from a queue payload.

## RB-09 Database production gate (owner: backend/SRE)

1. Take and independently verify a backup. Record `DATABASE_BACKUP_VERIFIED_AT`, `DATABASE_BACKUP_REFERENCE`, `DATABASE_RESTORE_TESTED_AT`, and `DATABASE_RESTORE_REFERENCE` from the restore system, not from application memory.
2. Run `pnpm --filter appointment-agent db:gate` with `DATABASE_URL` and `DATABASE_GATE_REQUIRE_TLS=true`. The command must report schema, RLS, role isolation, timeout, TLS, backup, and restore checks as passed.
3. Stop the deployment on any failure. Do not use `--skip` or edit `pg_class`/`information_schema` to make the gate pass. Preserve the report and the database backup with the release evidence.
4. Re-run the calendar and ledger integration suite against the same migration image. Roll back application traffic before any migration rollback; leave additive tables in place when safe.

## RB-10 Meta staging smoke (owner: integrations/on-call)

1. Confirm `META_SMOKE_ENVIRONMENT=staging`, an approved non-promotional template, a test recipient, and a dedicated staging phone number. Never use a production customer list.
2. Run `pnpm --filter appointment-agent smoke:meta` for the non-sending phone-number preflight. Record only provider request id/WAMID, safe status codes, and timestamps.
3. Run the signed webhook fixture and verify inbound text, button, duplicate, handoff, outbound reply, and delivery-status callbacks. Confirm the raw recipient is absent from logs, ledger rows, and metrics.
4. A template send requires `META_SMOKE_ALLOW_SEND=true`; without it the command exits blocked. For rate-limit or revoked-token tests, use a dedicated test tenant and preserve the safe error code.
5. If the provider returns `130429` or a timeout, stop the send loop, inspect tenant fairness and the account throughput tier, and reconcile any `unknown` ledger rows before resuming.

## RB-11 Reliability and chaos exercise (owner: SRE)

1. Before the exercise, export the SLO snapshot, queue age, database pool utilization, provider error rate, and ledger `unknown` count. Use synthetic WAMIDs and synthetic tenants only.
2. Run `pnpm --filter appointment-agent test:reliability` and the PostgreSQL calendar/ledger integration suite. Inject one database latency, one pool-exhaustion, one provider-timeout, and one worker-abort scenario at a time.
3. Stop the exercise if ACK latency exceeds 3 seconds, oldest job age exceeds 60 seconds, a duplicate calendar mutation appears, or an `unknown` row is resent without operator approval.
4. Record the failure matrix, elapsed recovery time, alert delivery, and remediation owner. Do not call the exercise complete without the production-like database and Meta evidence.

## RB-12 Enterprise access and operator actions (owner: security/operations)

1. Verify the OIDC issuer, audience, HTTPS JWKS endpoint, RS256 algorithm, `sid`, expiry, and MFA `amr` claims before enabling `/v1/operator/actions`.
2. Test owner/admin/operator/support/analyst/developer matrix and cross-tenant denial. A bearer token without a verified tenant membership is rejected before any action.
3. Require MFA and an append-only `operator_action_audit` row for replay, cancellation, or tenant-management actions. Never persist the free-form reason or access token.
4. Revoke the session and rotate provider credentials immediately if an operator token or JWKS response is suspected compromised. Preserve audit evidence and follow RB-06.

## RB-15 Staff sign-in, Calendar consent, and grant revocation (owner: security/operations)

1. Verify the issuer, JWKS URL, staff audience, and client credentials are a complete set per provider. A partial set fails closed with `oauth_configuration_invalid`; the workspace renders its sign-in notice rather than an unauthenticated dashboard. Confirm `STAFF_AUTH_REDIRECT_ALLOW_LIST` contains every configured callback URI, and that each callback is https (or an http loopback address with `STAFF_AUTH_ALLOW_INSECURE_LOOPBACK=true`).
2. Test the CSRF and replay controls on every callback before enabling access: a callback with no `state`, an unknown `state`, a malformed `state`, and a replayed `state` must each be refused with `oauth_state_missing` / `oauth_state_unknown` / `oauth_state_malformed` / `oauth_state_replayed`. Confirm the authorize redirect carries `code_challenge_method=S256`, a `nonce`, and no client secret.
3. Confirm the privileged gate stays closed: a staff session whose IdP reports no second factor must be refused `outbound:replay`, cancellation, and tenant management with `mfa_required`. Supabase reports this as `aal: "aal2"`; Google as an `mfa`/`otp`/`totp` entry in `amr`. Do not treat a missing claim as verified.
4. Confirm MFA is *derived*, never asserted by the client, and that a Google sign-in carries the configured `GOOGLE_WORKSPACE_HOSTED_DOMAIN` in its `hd` claim when one is set.
5. For a suspected credential leak: revoke the session from the operator surface, then revoke the Google grant. Grant revocation is two-sided — `revoke_google_grant` deletes the local row **and** asks Google to invalidate the credential; a local delete alone cannot un-mint a credential the provider already issued. Record tenant id, key ids, timestamps, and the revoke outcome, never the refresh token.
6. Rotate `STAFF_ACTION_RECEIPT_KEY_BASE64` after any suspected action-receipt key compromise. Rotation invalidates outstanding receipts only, so it is safe during an incident; it does not revoke sessions.
7. Preserved evidence: `state`/`nonce`/PKCE material, authorization codes, access tokens, ID tokens, refresh tokens, and email addresses must never appear in logs, metrics, incident records, or commits. The audit sink carries only a closed vocabulary of event names and outcomes plus a tenant id.

## RB-13 Disaster recovery (owner: infrastructure/SRE)

1. Validate approved RPO/RTO, backup reference, restore-test timestamp, and data-residency region. A missing value is a release blocker.
2. Rebuild in the order returned by `recovery_rebuild_order()`: database/migrations, provider credentials, HTTP health, worker, ledger reconciliation, then traffic.
3. After restore, verify tenant/resource ownership, calendar operation replay, outbound `unknown` rows, RLS/role checks, and SLOs before reopening traffic.
4. Record actual RPO/RTO and every manual decision. A code contract without a restore exercise is not DR evidence.

## RB-14 Incident severity, communications, and postmortem (owner: SRE)

P1.4 evidence: severity levels, communications roles, postmortem template, and the first on-call handoff exercise record live here; no separate incident doc is authoritative.

Severity levels (customer impact decides, not effort):

1. SEV1 critical: booking writes failing, cross-tenant leak suspected, or provider outage with no failover. Page on-call immediately; acknowledge within 5 minutes.
2. SEV2 major: degraded ACK latency (>3s p95), queue age (>60s oldest job), or single-tenant outage. Page on-call; acknowledge within 15 minutes.
3. SEV3 minor: elevated error budget burn, single retry storm, or non-blocking integration fault. Ticket for the owning team; review within one business day.
4. SEV4 informational: threshold warnings with no customer impact. Ticket only; review at the next ops cadence.

Communications roles (declare at incident start, record in the incident thread):

1. Incident commander owns priority, scope, and the decision log.
2. Operations lead executes runbook steps and reports state changes only (no raw message content, recipients, or secrets in chat).
3. Customer liaison owns status updates to affected tenants with plain-language impact and next-update time.
4. Scribe records timeline, commands, and evidence links for the postmortem.

Postmortem template (file within 48 hours for SEV1/SEV2, link the incident thread):

1. Summary: one paragraph of customer impact with start/end timestamps.
2. Timeline: detection, escalation, mitigation, and resolution with evidence links.
3. Root cause: failed contract or invariant, not a person.
4. Remediation: code or runbook change with owner and due date; verification test named.
5. Follow-ups: residual risks moved to the backlog with explicit owners.

On-call handoff exercise record:

1. First tabletop exercise: scheduled before pilot traffic; participants are the on-call, backend owner, and customer liaison. Scenario: Meta timeout storm with `unknown` ledger rows. Validate: paging works, RB-08/RB-10 steps execute in order, no manual replay without MFA audit.
2. Record here after the exercise: date, participants, scenario, time-to-acknowledge, gaps found, and remediation owners. An unrecorded exercise did not happen.
