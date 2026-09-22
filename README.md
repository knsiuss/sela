# Sela — AI receptionist that fills every empty slot

> Working title, see Naming below. Status: MVP scaffold + research; pilot not started.

WhatsApp/SMS-first AI agent for SMB appointment businesses (clinic, dental, physio, salon, HVAC). It reads free-text replies, reschedules into live slots, refills cancellations from the waitlist, and hands off to humans when judgment is needed. Measured by recovered revenue, not reminders sent.

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
