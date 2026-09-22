# ADR 0001 — Mono repo (pnpm + Turborepo)

Status: Accepted (23 Sep 2026)
Deciders: product team
Scope: seluruh kode (apps, packages, infra) + docs tetap di repo yang sama.

## Context

Satu produk (appointment agent) + adapter PMS per vertikal + dashboard + infra. Polyrepo menambah version-mismatch dan duplikasi sejak hari pertama. Tim kecil JS/TS, tanpa build platform group.

## Decision

- Satu Git monorepo: `apps/*` (deployable), `packages/*` (shared library), `infra/*`, `docs/*`.
- pnpm workspaces + Turborepo (content-aware cache, parallel tasks, `turbo.json` pipeline build/typecheck/test).
- Trunk-based: branch pendek `feature/*`, merge cepat, CI affected-only (menyusul).
- CODEOWNERS per top-level dir (menyusul saat tim >3 orang).

## Alternatives considered

- Bazel/Buck2 (Google/Meta-scale, hermetic, polyglot): DITOLAK — butuh build engineer dedikasi; 6-engineer shop tenggelam di migration cost. Tinjau ulang bila 200+ engineer atau C++/Go masuk repo.
- Nx: DITUNDA — ambil saat >50 packages butuh generators + guardrails arsitektur.
- Polyrepo per vertikal: DITOLAK — adapter PMS justru butuh diubah bersamaan dengan core.

## Consequences

- Plus: satu source of truth, refactor lintas app+package atomik, cache CI.
- Minus: butuh disiplin boundaries (app tidak import dari app lain, hanya dari packages); repo membesar — mitigasi: sparse-checkout bila perlu.
- Migrasi: `product/` → `apps/appointment-agent/` (selesai); `slot-engine`/`guardrails` diekstrak dari app saat dipakai adapter kedua.

## Sources

- https://daily.dev/blog/monorepo-turborepo-vs-nx-vs-bazel-modern-development-teams/
- https://sourcegraph.com/blog/monorepo-build-tools
- https://www.aviator.co/blog/monorepo-tools/
- https://singhajit.com/how-google-manages-its-monorepo/ (Piper/Blaze — yang dicopy polanya, bukan toolnya)
