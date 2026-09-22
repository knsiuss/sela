# 01 — System Architecture

> Sumber: subagent deep-research arsitektur (Firecrawl developer-search + scrape halaman resmi, Sep 2026). Pola third-party = opini untuk didesain melawan, bukan standar.

## Pipeline (minimal, builder-safe)

```text
webhook ingress (verify sig → ACK 200 cepat → dedupe wamid → enqueue)
  → LangGraph-TS agent (checkpointer Postgres, thread_id = conversation id;
     tools: check_availability / hold_slot / confirm / cancel)
  → booking service = single writer (hold TTL 5-10 mnt server-enforced +
     atomic claim + EXCLUDE USING gist + audit log)
  → notifier worker (template sends, retry idempotent)
  → analytics DARI audit log, bukan dari trace store
```

## Fakta pengikat

| Fakta | SoT |
|---|---|
| LangGraph persistence = Checkpointer (thread-scoped: continuity, HITL, time-travel, fault tolerance) + Store (cross-thread: prefs/fakta); thread keyed `thread_id` | https://github.com/langchain-ai/docs/blob/cf8a317c729de3514cb39d89e355f0781109e812/src/oss/langgraph/persistence.mdx |
| Durability `"exit"` tercepat tapi tanpa mid-execution crash recovery — booking flow panjang butuh lebih kuat | https://github.com/langchain-ai/docs/blob/cf8a317c729de3514cb39d89e355f0781109e812/src/oss/langgraph/checkpointers.mdx |
| `interrupt()` = pause, checkpoint persist, resume bisa jauh kemudian/mesin lain, manusia boleh edit state sebelum resume | sama + https://www.langchain.com/blog/making-it-easier-to-build-human-in-the-loop-agents-with-interrupt |
| Webhook Meta: retry non-200 frequency menurun s.d. 7 hari, retry bisa duplikat; tiap inbound bawa `wamid.*` stabil; payload s.d. 3 MB | https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks |
| Postgres `EXCLUDE USING gist (resource WITH =, slot_range WITH &&)` (+`btree_gist`) bikin overlap mustahil di DB — garis pertahanan terakhir | https://github.com/supabase/supabase/blob/01ba39163f82c162da9b3f791413b45edc74338e/apps/www/_blog/2024-07-11-range-columns.mdx |
| Advisory locks / `SELECT ... FOR UPDATE SKIP LOCKED` = mekanisme single-writer mapan di Postgres | https://riverqueue.com/blog/uniqueness-with-advisory-locks |

## Lapis anti double-book (defense in depth)

1. Ingress dedupe `wamid` (unique constraint, return 200 sebelum kerja berat).
2. Hold row TTL + atomic claim (`UPDATE ... WHERE status='held' AND expires_at>now()` atau advisory lock per slot).
3. `EXCLUDE USING gist` sebagai backstop DB.
4. Audit/event log append-only transisi hold→confirm/cancel/expire (sengketa + analitik).

## Failure modes untuk didesain melawan (opini campuran, bukan standar)

Slow ACK → retry storm → duplikat; race 2 user 1 slot; LLM confirm tanpa re-check (stale read); hold hoarding = calendar DoS (mitigasi: TTL server-enforced + cap per user); bug timezone (simpan UTC, render tz bisnis).

## Tiga invariant (encode pertama)

1. Jangan confirm tanpa re-check availability segar di dalam transaksi tulis.
2. Tiap mutasi booking idempotent via unique constraint (wamid / idempotency-key).
3. Simpan UTC, render tz lokal bisnis.
