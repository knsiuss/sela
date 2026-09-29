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
2. Rotate the Meta credential in the secret provider, then confirm a canary send for the tenant and an unmapped-tenant fail-closed check. Roll back by re-revoking; rotation applies to new sends without a restart.
3. Rotate a recipient key by adding the new key id to `WHATSAPP_RECIPIENT_ENCRYPTION_KEYS_JSON` with the old id retained (overlap ≤8 keys), switching `active_key_id`, and verifying old rows still open. Remove the old id only after retention expiry. Approval: security owner + on-call sign-off; record key ids (never values), timestamps, and the rotation drill result here.
