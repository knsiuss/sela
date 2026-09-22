# 04 — Progress Tracking

> Update tiap milestone. Format: tanggal — hasil — bukti — berikutnya.

## Log

- 22 Sep 2026 — Riset strategi + produk selesai (01-Strategy 6/6 awal, 02-Product berjalan). Bukti: docs/01-Strategy, docs/02-Product. Berikutnya: technical.
- 23 Sep 2026 — Monorepo ADR 0001 diterapkan (pnpm+turbo, apps/*, packages/*). Bukti: `pnpm install` 87 pkgs OK; docs/adr/0001-mono-repo.md. Berikutnya: scaffold LangGraph.
- 23 Sep 2026 — Scaffold `apps/appointment-agent` hijau: typecheck bersih, test 5/5 (anti double-book + hold expired). Bukti: `npx tsc --noEmit`, `npx vitest run`. Berikutnya: `mcp-gcal` nyata.
- 23 Sep 2026 — Firecrawl self-host hidup `:3002` + scrape keyless terbukti. Bukti: liveness 200, scrape example.com success. Berikutnya: restart opencode (load `firecrawl_local`).
- 23 Sep 2026 — Docs 01/02/03 penuh (18 file). Berikutnya: 04-Go-to-Market + Appendix.
- OPEN — Restart opencode untuk load MCP `firecrawl_local`.
- OPEN — `packages/mcp-gcal` gantikan `InMemoryCalendar`.
- OPEN — Template WhatsApp utility submit (butuh WABA + nomor).
- OPEN — Lokasi pilot + baseline audit 7-14 hari.
