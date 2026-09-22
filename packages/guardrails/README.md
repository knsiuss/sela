# @repo/guardrails

Shared policy checks (PII redaction, human-in-the-loop gates) for
appointment apps.

## Status

Placeholder. Per ADR 0001, policy logic is extracted here when a second
consumer needs it. Until then, `apps/appointment-agent` keeps its own
implementation and this package only reserves the import boundary.

## Layout

- `src/index.ts` — placeholder verdict type and check signature.
- `tsconfig.json` — extends the root `tsconfig.base.json`.
