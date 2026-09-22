# 01 — Implementation Roadmap

> Start 23 Sep 2026. Benchmark: MVP tipikal 8-16 minggu; AI compress 25-40% (hemat 2-4 minggu); pola 6 minggu pilot-to-production (audit → 1 agent → stress test); paket AI-agent 4 minggu (discovery → build). SoT: https://forcoda.com/blog/mvp-development-time · https://technijian.com/software-development/mvp-development-timeline-2026-how-long-it-actually-takes-to-go-from-idea-to-launch/ · https://riverborn.com/packages/30-day-ai-agent-mvp · https://helo.ai/resources/blog/whatsapp-chatbot-integration (enterprise WA 2-4 minggu).

## Timeline penyelesaian

| Fase | Periode | Output | Exit criteria |
|---|---|---|---|
| 0 Riset | 22-23 Sep ✅ | docs 01-03 penuh + ADR 0001 + scaffold hijau | Selesai |
| 1 MVP build | 23 Sep - 28 Okt (5 minggu) | `mcp-gcal` nyata, WA sender + webhook, dashboard v1, template approved | typecheck + test hijau; 0 double-book di simulasi |
| 2 Pilot 30 hari | 29 Okt - 27 Nov | 1 lokasi 20-50 appt/hari live | Gate 05-Success-Metrics (reduksi ≥25-30%, fill ≥40-50%, 0 double-book, N≥600) |
| Gate | 28-30 Nov | Go / extend 60 hari / pivot adapter | Keputusan tercatat D-log |
| 3 PMF | Des 2026 - Feb 2027 | Waitlist auto, 2 PMS, 20-50 lokasi se-vertikal | Reschedule completion >60%, churn <5%/mo |
| 4 Scale | Mar 2027+ | Multi-location, voice eskalasi, recall | 200+ lokasi atau ARR model pilot |

## Minggu-per-minggu fase 1

- M1 (23-30 Sep): GCal adapter + webhook ingress (verify+dedupe+enqueue) + template utility submit.
- M2 (30 Sep-7 Okt): WA sender idempotent + confirm flow + handoff OPERATOR + audit log.
- M3 (7-14 Okt): dashboard recovered revenue + opt-in/out + kalkulator biaya.
- M4 (14-21 Okt): stress test (race slot, retry storm, hold expiry) + pilot baseline audit lokasi.
- M5 (21-28 Okt): hardening + template approved + go-live checklist + freeze scope.

Keterlambatan khas: approval template Meta/BSP + OAuth tenant pertama + integrasi PMS — mulai M1, bukan M4.
