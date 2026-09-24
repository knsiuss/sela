# @repo/guardrails

Shared policy checks (PII redaction, human-in-the-loop gates) for
appointment apps.

## Status

Types only, no implementation. Policy ownership:

| Rule | Owner today |
|---|---|
| Deny-list handoff reasons (operator, emergency, billing, explicit human) | `apps/appointment-agent/src/handoff.ts` |
| Confidence + unknown-intent gate | `apps/appointment-agent/src/guardrails.ts` |

Per ADR 0001, these move here when a **second** consumer appears. The
Sep 2026 dedup removed the previous `check_guardrails()` placeholder because
it returned `allowed: true` for every input; an allow-all safety gate is worse
than a missing symbol.

## Layout

- `src/index.ts` — verdict type only.
- `tsconfig.json` — extends the root `tsconfig.base.json`.

## Rule for extraction

Move the detector here unchanged, keep the app file as a re-export, and add a
test that imports the package path. Never keep two definitions of the same
deny-list, which caused the duplicate-gate drift found in the audit.
