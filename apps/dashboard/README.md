# @repo/dashboard

Staff dashboard for the appointment agent (appointment list, approvals).

## Status

Scaffold only. The UI lands in a later milestone; this app currently
exposes a health check so build, typecheck, and test pipelines have a
baseline to run against.

## Run

```bash
pnpm --filter @repo/dashboard typecheck
pnpm --filter @repo/dashboard test
pnpm --filter @repo/dashboard dev
```

## Layout

- `src/index.ts` — placeholder entrypoint with health check.
- `test/health.test.ts` — health check test.
- `tsconfig.json` — extends the root `tsconfig.base.json`.
