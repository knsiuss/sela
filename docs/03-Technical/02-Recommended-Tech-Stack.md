# 02 — Recommended Tech Stack

> Sumber: subagent yang sama dengan 01-System-Architecture. Harga dari scrape resmi 22-23 Sep 2026.

## Picks

| Lapisan | Pilihan | Alasan |
|---|---|---|
| Runtime | Node 24 LTS ("Krypton", s.d. Okt 2026); baseline modern ≥22.6 | https://www.pkgpulse.com/guides/nodejs-22-vs-nodejs-24-2026 |
| Monorepo | pnpm workspaces + project refs; Turborepo saat build melambat | https://hsb.horse/en/blog/typescript-monorepo-best-practice-2026/ — cocok ADR 0001 |
| DB | Postgres (Neon/Supabase/RDS) + `btree_gist` + `tstzrange` | Backstop exclusion constraint; semua pola single-writer di atas |
| Queue | pg-boss (atau BullMQ backend-PG) di Postgres untuk reminder/follow-up/retry tertunda | Satu stateful service lebih sedikit; enqueue transaksional bareng tulis booking. BullMQ-PG ≈ 60-90% throughput Redis di bulk; Redis default tetap battle-tested. https://github.com/taskforcesh/bullmq/blob/64133c2d719eb6a992cd6247fb87328d52048ecd/docs/gitbook/guide/postgresql.md · https://www.pkgpulse.com/guides/bullmq-vs-bee-queue-vs-pg-boss-job-queues-nodejs-2026 |
| Cache | Redis-compatible (Upstash hindari ops) HANYA untuk dedupe/hold fast-path/read-through; Postgres tetap source of truth | Tambah hanya saat rate-limit/cache atau throughput terbukti lampaui PG |
| Agent | LangGraph-TS + checkpointer Postgres + Store untuk prefs lintas-thread | Lihat 03-AI-Agent-Framework-Choice |

## Observability (fakta pricing scrape)

| Opsi | Harga | Posisi |
|---|---|---|
| LangSmith | Developer $0 (1 seat, 5k traces); Plus $39/seat (10k + PAYG); Enterprise custom = satu-satunya self-host/hybrid. Unit: LCU $1,50, LSU $1,00 | Zero-config + evals terdalam LangGraph; closed source; pajak per-seat |
| Langfuse | Hobby free (50k units, 2 users, 30 hari); Core $29 (100k incl, +$8/100k menurun); Pro $199; Enterprise $2.499. Self-host eksplisit | Kurva volume termurah + opsi self-host; agnostik framework, OTel |
| Helicone | Hobby free (10k req); Pro $79 (unlimited seats + usage); Team $799 | Gateway/cache 1-baris + cost analytics; evals/tracing lebih tipis (diakui halaman komparasi mereka) |

SoT: https://www.langchain.com/pricing · https://langfuse.com/pricing · https://www.helicone.ai/pricing
Contoh hitung pihak ketiga (~500k traces: Langfuse ~$241 vs LangSmith ~$2.567/3 seats) = matematika blog itu, bukan verifikasi kami. Lisensi: Langfuse MIT, Helicone core open-source, LangSmith proprietary. Self-host Langfuse = Postgres + ClickHouse + Redis + object storage (berat); Arize Phoenix single-container alternatif (belum dievaluasi dalam).

Rekomendasi: mulai Langfuse Cloud Hobby/Core (volume murah, tanpa pajak seat, path self-host terjaga); LangSmith Developer tier untuk debug LangGraph saat build; Helicone hanya bila butuh gateway caching/atribusi biaya. Tinjau saat volume × retensi diketahui.

## Stack terkunci Sela (23 Sep 2026, terobservasi dari repo — bukan rekomendasi umum)

| Lapisan | Terkunci | Bukti |
|---|---|---|
| Node | v24.18.0 LTS | `node --version` |
| pnpm | 9.0.0 aktif (`packageManager: pnpm@9.0.0`) | `pnpm --version` + root package.json |
| Turbo | 2.11.3 | pnpm install output |
| TypeScript | 5.9.3 | sama |
| Docker | 29.6.1 | `docker --version` |
| @langchain/langgraph | 0.2.74 (core 0.3.80, zod 3.25.76) | pnpm-lock.yaml |
| vitest / tsx / dotenv | 2.1.9 / 4.23.15 / 16.6.1 | pnpm-lock.yaml |

| Service (D:\firecrawl) | Port | Status 23 Sep |
|---|---|---|
| api | 3002 published (`PORT:INTERNAL_PORT`) | Hidup, liveness 200, scrape keyless terbukti |
| extract-worker | 3004 internal | Running |
| worker liveness | 3005 internal | Running |
| nuq-postgres / redis / rabbitmq / foundationdb | internal | Healthy/running |

| MCP di opencode | Endpoint | Pakai untuk |
|---|---|---|
| firecrawl (cloud) | mcp.firecrawl.dev/v2/mcp | search (index) |
| firecrawl_local | stdio `firecrawl-mcp@3.23.7` → `FIRECRAWL_API_URL=http://localhost:3002` | scrape/crawl/map/parse bebas limit |
| github / supabase / sentry / vercel / cloudflare | config opencode.json | repo, DB, error, deploy |

Env yang wajib ada: `.env` root firecrawl (`USE_DB_AUTHENTICATION=false`, `PORT=3002`); `apps/appointment-agent/.env` ikut `.env.example` (GCal OAuth, WA token, thresholds). Secrets tidak pernah di-commit (AGENTS.md §13).
Upgrade policy: kunci minor via lockfile; bump deliberatif + `pnpm test` hijau; catat di Progress-Tracking.
