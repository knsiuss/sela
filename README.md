# Sela — AI receptionist for appointment businesses

> Working title, see Naming below. Status: MVP scaffold + research; pilot not started.

Sela is a WhatsApp/SMS-first AI receptionist for small appointment businesses such as clinics, dental practices, physios, salons, and HVAC services. Its goal is to recover paid appointment capacity without asking staff to manually coordinate every change.

## The problem

Customers usually contact a business when something changes: they forget an appointment, need a different time, miss a call, or cancel close to the appointment date. A one-way reminder does not resolve that request. Staff must identify the existing appointment, find a valid replacement, confirm the customer, and update the calendar. If that process is slow or unavailable after hours, an otherwise paid slot remains empty.

## The main problem

The core problem is not sending more reminders; it is safely completing an appointment change while the calendar remains the source of truth. A reminder-only bot leaves the difficult work—understanding the request, selecting a live slot, obtaining explicit consent, and writing the change without a race—to humans. Removing the human step without expiring holds, idempotent writes, tenant boundaries, and a clear handoff can create double bookings and privacy or authorization failures.

## The solution

Sela turns the customer reply into a bounded, auditable flow:

1. Read a free-text request and identify the requested action.
2. Offer a small set of currently available slots.
3. Reserve the selected slot with a short, expiring hold.
4. Require explicit customer confirmation before an irreversible write.
5. Perform an idempotent, tenant-scoped calendar update.
6. Escalate ambiguity, sensitive requests, missing appointment context, expired holds, or unexpected failures to a human.
7. Keep operational evidence and health signals without placing message content, recipient data, or secrets in logs.

The product vision also includes cancellation-to-waitlist backfill and recovery of newly empty slots. The current app is focused first on the reschedule path and its safety boundaries; it is not an autonomous cross-tenant booking system.

## About this app

The runnable application is `apps/appointment-agent`, a TypeScript/LangGraph runtime scaffold. It includes:

- a local CLI for exercising the conversation flow;
- a tenant-aware WhatsApp HTTP ingress and worker;
- Postgres-backed sessions, calendar operations, rate limits, and an outbound delivery ledger;
- recipient encryption, signed webhook verification, operator authorization, and human-handoff gates;
- structured health/metrics endpoints and automated unit, reliability, and database integration checks.

The default CLI is a local scaffold. Database-backed deployment requires the migrations and production configuration described in [`apps/appointment-agent/README.md`](apps/appointment-agent/README.md). External calendar/provider credentials, production secrets, live Meta testing, and operator-specific approval integrations are not bundled.

## Monorepo layout (ADR 0001)

```text
apps/appointment-agent/   LangGraph TS runtime (MVP scaffold, typecheck + tests green)
packages/slot-engine/     Slot-hold + single-writer logic (to extract on 2nd adapter)
packages/guardrails/      Handoff gates (to extract on 2nd adapter)
packages/mcp-gcal/        Google Calendar connector as MCP (next)
packages/ui/              Recovered-revenue dashboard (next)
infra/docker/             Local infra notes
docs/                     Strategy → Product → Technical → GTM → Execution → Appendix
docs/adr/                 Architecture Decision Records
docs/research-notes/      Unverified scratch (promote only with sources)
```

## Quickstart

```bash
pnpm install
pnpm --filter appointment-agent test
pnpm --filter appointment-agent dev -- "mau geser ke kamis sore bisa?"
```

Full pipeline: `pnpm build` · `pnpm typecheck` · `pnpm test` (Turborepo).

## Docs map

- Start: `docs/00-DOCS_STRUCTURE_DETAILED.md`
- Strategy: `docs/01-Strategy/` (problem with source-of-truth, market range, competitors, pricing)
- Product: `docs/02-Product/` (MoSCoW, personas, channel, pilot gates)
- Technical: `docs/03-Technical/` (research running)
- Decisions: `docs/05-Execution/06-Decision-Log.md`
- Rules for agents: `AGENTS.md` (snake_case, English, docstrings, domain exceptions)

## Non-goals (V1)

Voice calls, multi-location sync, no-show prediction scoring, outcome-based pricing. See `docs/02-Product/01-Core-Features-and-Scope.md`.

## Naming

Working title **Sela** (Indonesian: the gap between — the empty slot we fill). Alternatives considered: IsiSlot, JagaJadwal, Slotback. Verify trademark + domain + WhatsApp display-name policy before launch.
