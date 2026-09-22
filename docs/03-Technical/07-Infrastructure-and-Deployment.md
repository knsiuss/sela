# 07 — Infrastructure and Deployment

> Harga/limit vendor per Sep 2026, berubah — verifikasi live, jangan jadi angka kontrak.

## WhatsApp infra checklist (fakta Meta)

- Permission `whatsapp_business_messaging` + `whatsapp_business_management`; payload ≤3MB; gagal/non-200 = retry menurun s.d. 7 hari → dedupe wajib; dukung mTLS + IP allowlist (berubah berkala). https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/
- Messaging limit = nomor unik di luar service window per 24 jam geser, level portfolio; 250 → 2000 (verifikasi/scaling) → 10k → 100k → unlimited bila kualitas tinggi + pakai ≥50% 7 hari. Tier lama deprecated. https://developers.facebook.com/docs/whatsapp/messaging-limits/
- Enforcement kualitas/spam + template quality score; template bermasalah di-pause. https://developers.facebook.com/documentation/business-messaging/whatsapp/policy-enforcement
- Wajib: endpoint verifikasi + signature, queue consumer, dedupe `wamid`, template registry + fallback, pantau quality/limit tier, log delivered/read/failed, rate-limiter per nomor/portfolio, handling opt-out STOP + jendela 24 jam.

## Opsi hosting (sekunder, recek live)

Render Postgres $7-450+/bln; app kecil (web+worker+cron+PG+Redis) ±$50-80/bln; Railway usage-based + egress + seat; Render flat termasuk 100GB egress + PITR/replica tier atas. SoT: https://encore.dev/articles/render-vs-railway · https://northflank.com/blog/railway-vs-render · https://railway.com/pricing

Rekomendasi tim kecil: Supabase Postgres (RLS+PITR+backup harian) + PaaS web+worker + Redis managed + BullMQ (atau pg-boss tanpa Redis) + Sentry + uptime check + alert queue-depth/webhook-fail/backup-age. VPS tunggal hanya bila kuat ops. AWS (RDS+ElastiCache+SQS) saat >100 rps sustained / VPC-BAA ketat.
Kunci scale 10-50x: stateless app, worker terpisah, outbox+idempotensi, `statement_timeout`, pooling (PgBouncer), index tenant-leading, PITR + restore drill SEBELUM launch.
