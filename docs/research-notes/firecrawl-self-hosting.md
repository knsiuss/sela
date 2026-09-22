# Firecrawl Self-Hosting — Research Notes

> Status: verified-against-local-checkout (`D:\firecrawl`) + official self-host guide (23 Sep 2026).

## Decision addressed

How to run the local Firecrawl compose stack, when to use local vs Cloud, what the
observed rate limit means, and which endpoints are source-verified.

## Scope and question

- In scope: first-run compose procedure at `D:\firecrawl`, local-vs-Cloud rule of
  thumb, observed request rate limit, source-verified endpoints.
- Out of scope: production hardening design, code changes, vendor recommendation.
- Assumption: evaluation baseline on a trusted network (unauthenticated by default).

## Findings

### 1. Running the local compose stack (VERIFIED)

Pinned reference: official guide verified against release `v2.11.162`; always review
the target release's own `docker-compose.yaml` before reusing these values, since a
`main` checkout can drift from any single guide revision.

1. Clone and pin: `git clone https://github.com/firecrawl/firecrawl.git`,
   `git checkout <tag>` (guide used `v2.11.162`).
2. Minimal root `.env` (Compose defaults cover the rest):
   `USE_DB_AUTHENTICATION=false`, `POSTGRES_USER`, `POSTGRES_PASSWORD` (guide: use a
   long random value), `POSTGRES_DB=postgres` (the bundled `pg_cron` config targets
   the default `postgres` database). Local checkout `D:\firecrawl\.env` currently
   holds only `USE_DB_AUTHENTICATION=false` and `PORT=3002`; Compose defaults fill
   user/password/db with `postgres` (`docker-compose.yaml:28-30`), and
   `USE_DB_AUTHENTICATION` defaults to `false` (`docker-compose.yaml:33`).
3. Start: `docker compose up --build -d`, then `docker compose ps --all`. Leave
   `NUQ_BACKEND` and `BULL_AUTH_KEY` unset for the first run (PostgreSQL queue, no
   queue-admin UI).
4. Reachability check (heartbeat only — does not validate Redis/Postgres/RabbitMQ/
   Playwright/workers): `curl http://localhost:3002/v0/health/readiness` expects
   `{"status":"ok"}`.
5. Functional smoke test (the check that actually matters):
   `POST http://localhost:3002/v2/scrape` with
   `{"url": "https://example.com", "formats": ["markdown"], "timeout": 60000}`
   expects `{success: true, data: {markdown, metadata}}`.
6. Stack shape (`SELF_HOST.md:43-47`, `docker-compose.yaml:62-226`): API + workers,
   Playwright service, Redis, RabbitMQ, NuQ PostgreSQL, plus optional FoundationDB
   backend services. **Only the API is published to the host, on port 3002**
   (`docker-compose.yaml:119-120`). The Compose file defines no persistent volumes
   for PostgreSQL/Redis/RabbitMQ — data does not survive service replacement without
   added storage/backup work. `apps/api/.env.example` is for API development, not a
   Compose contract.

### 2. Local vs Cloud (VERIFIED — official guide)

| Need | Choice |
|---|---|
| Source or infrastructure control; validating Firecrawl against our environment; owning upgrades, secrets, storage, monitoring, recovery | Self-host (trusted network for eval) |
| Fastest supported path to production; no ops burden | Firecrawl Cloud |
| LLM-backed extraction formats | Either, but self-host needs an OpenAI-compatible provider or Ollama wired in |
| Fire-engine anti-bot behavior, screenshots/page actions, Agent/Browser/interact, specialized product/menu/audio/video formats | Cloud (not in default self-host stack; screenshots/actions explicitly unsupported without Fire-engine) |

### 3. Rate limit observation (OBSERVED, not a documented limit)

- During this research, Firecrawl **Cloud** search returned HTTP 429 with
  `Consumed (req/min): 11, Remaining (req/min): 0`, retry after ~35s. This confirms
  Cloud API calls are per-minute rate-limited and 429-backoff is mandatory.
- The previously noted "13 req/min" figure is a **prior local observation,
  UNVERIFIED** as a documented limit: no per-minute numeric limit was found in
  `SELF_HOST.md` or `docker-compose.yaml` (only `REDIS_URL`/`REDIS_RATE_LIMIT_URL`
  plumbing, `docker-compose.yaml:25-26`). Treat any fixed req/min number as UNKNOWN;
  implement retry-with-backoff on 429 instead of coding to a number.

### 4. Source-verified endpoints (local checkout `D:\firecrawl`)

- `GET /` → `{"message": "Firecrawl API", "documentation_url": ...}`
  (`apps/api/src/index.ts:121`). Liveness proof for "is this a Firecrawl API".
- `GET /e2e-test` → `200 OK` (`apps/api/src/index.ts:128`). Cheapest uptime probe.
- Health is **two** routes, not a bare path: `GET /v0/health/liveness` and
  `GET /v0/health/readiness` (`apps/api/src/routes/v0.ts:42-43`). The guide's
  readiness check is the canonical first probe; bare `/v0/health` does not exist.
- `POST /v1/scrape` is registered with `{ allowKeyless: true }`
  (`apps/api/src/routes/v1.ts:52`; same flag on search at `v1.ts:81`). Keyless is
  **OFF unless BOTH** `KEYLESS_REQUESTS_PER_DAY` and `KEYLESS_CREDITS_PER_DAY` are
  configured (`apps/api/src/lib/keyless.ts:22-24,37-38`); otherwise callers get
  plain Unauthorized, and exhausted budgets get the 429 free-tier message.
- Self-host baseline (`USE_DB_AUTHENTICATION=false`) needs **no API key or
  Authorization header** — requests use a self-hosted identity. Never expose this
  unauthenticated baseline beyond a trusted network; auth/TLS/persistence are
  explicit pre-production decisions, not single-env-var flips.

## Recommendation

Keep the pinned-tag baseline on a trusted network: `up --build -d`, then require
both the readiness probe and one real `POST /v2/scrape` against `example.com`
before treating the deployment as usable. Use local for evaluation and controlled
research prep, Cloud for anything needing Cloud-only capabilities or managed ops.
Back off on any 429; do not hard-code a req/min number.

## Assumptions and limitations

- Verified against the local `D:\firecrawl` checkout and the official guide as read
  23 Sep 2026; the checkout's exact release tag was not pinned in this pass —
  confirm `git describe`/tag before changing the baseline.
- No containers were started and no live scrape was executed here; endpoint behavior
  is source-verified, smoke-test flow is doc-verified.
- Keyless/Cloud quota mechanics observed from Cloud 429 copy and source comments,
  not from a quota-exhaustion experiment.

## Sources

- Self-hosting Firecrawl (official guide) — https://docs.firecrawl.dev/contributing/self-host
- Pinned Compose reference cited by the guide — https://github.com/firecrawl/firecrawl/blob/v2.11.162/docker-compose.yaml
- `D:\firecrawl\SELF_HOST.md` (local checkout: baseline rules, stack shape, pre-production list)
- `D:\firecrawl\docker-compose.yaml` (local checkout: env defaults, services, port 3002)
- `D:\firecrawl\apps\api\src\index.ts:121,128` (local: `/`, `/e2e-test`)
- `D:\firecrawl\apps\api\src\routes\v0.ts:42-43` (local: health liveness/readiness)
- `D:\firecrawl\apps\api\src\routes\v1.ts:52,81` (local: `allowKeyless` on scrape/search)
- `D:\firecrawl\apps\api\src\lib\keyless.ts:22-24,37-38` (local: keyless OFF unless both limits set)
- `D:\firecrawl\.env` (local: `USE_DB_AUTHENTICATION=false`, `PORT=3002`)

## Blocker

- None for local evaluation. Production exposure needs explicit auth, TLS, and
  persistence decisions (exact decision needed before the API leaves a trusted network).
