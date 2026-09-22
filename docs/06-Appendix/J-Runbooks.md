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
