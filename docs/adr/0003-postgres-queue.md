# ADR 0003 — Postgres + queue di Postgres

Status: Accepted (23 Sep 2026)
Context: butuh queue reminder/retry tanpa tambah service. Alternatif: BullMQ-Redis, RabbitMQ sendiri.
Decision: Postgres sebagai DB + queue (pg-boss atau BullMQ backend-PG); Redis-compatible hanya untuk dedupe/hold fast-path bila terbukti perlu. Bukti: `docs/03-Technical/02-Recommended-Tech-Stack.md`.
Consequences: Plus: 1 stateful service lebih sedikit, enqueue transaksional bareng tulis booking. Minus: throughput di bawah Redis (60-90%); migrasi bila terbukti sesak.
