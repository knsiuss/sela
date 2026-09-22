# RFC 0001 — Sela MVP: WhatsApp/SMS reschedule agent

```text
Title: Sela MVP reschedule agent (1 nomor, GCal, 1 lokasi pilot)
Author: product team
Status: Approved (scope dari D-03 Decision-Log)
Reviewers: owner
Date: 2026-09-23
```

## 1. Summary

Agent WhatsApp/SMS yang membaca balasan bebas, rebook ke slot live (hold + konfirmasi + tulis idempotent), refill cancel dari waitlist, dan handoff ke staf saat ragu/sensitif. Diukur dari recovered revenue, bukan reminder terkirim.

## 2. Context & Problem

No-show ~23% (105 studi); lupa 33-44%; 41% call di luar jam kerja dengan 23% missed; cancel 5-30% jadi kursi kosong. Reminder 1-arah tidak menutup rantai gagal. SoT: `docs/01-Strategy/02-Problem-Definition-and-Market-Pain.md`.

## 3. Goals

- Pilot 30 hari: reduksi no-show relatif ≥25-30%, fill cancel ≥40-50%, 0 double-book, time-to-fill <30 mnt, N≥600 + p<0,05.
- Recovered revenue/lokasi/bln > fee.

## 4. Non-Goals

Voice calls; multi-location sync; no-show prediction scoring; outcome-based pricing; PMS kedua; Meta Business Agent sebagai mesin. (Daftar penuh: `02-Product/01-Core-Features-and-Scope.md`.)

## 5. Proposed Design

- C4 L1/L2/L3: `03-Technical/architecture.md` + `06-Appendix/D-Architecture-Diagrams.md`.
- State machine: parse → offer → hold → confirm (HITL `interrupt`) → write. Kode: `apps/appointment-agent/src/graph.ts`.
- Data: `packages/db/migrations/0001_init.sql` + `0002_rls.sql`; ERD `docs/assets/diagrams/erd-appointments.md`.
- API contract: `CalendarPort`/`BookingPort`/`NotifyPort` (internal dulu; OpenAPI publik menyusul saat multi-adapter).
- Sequence kritis: reschedule E2E + cancel→waitlist (`02-Product/04-Conversation-Flows.md`).

## 6. Alternatives Considered

| Alternatif | Pros | Cons | Kenapa ditolak |
|---|---|---|---|
| CrewAI role-based | Cepat prototipe | Lemah state machine transaksional | Butuh interrupt+checkpoint |
| MS Agent Framework | Graph + modern | Muda; checkpoint terdistribusi belum terbukti | Tunda |
| OpenAI Agents SDK | Guardrails tripwire matang | Handoff-sentris, bukan graph | Cadangan bila OpenAI-first |
| Bazel monorepo | Hermetic scale raksasa | Butuh build team | pnpm+turbo cukup |
| Voice-first | Tangkap after-hours语音 | $0,40-0,70/call, hancurkan flat-rate SMB | Eskalasi saja |

## 7. Scalability & Performance (back-of-envelope)

1 lokasi 50 appt/hari ≈ 1.500/bln; chat ±5 msg/appt ≈ 7.500 msg/bln ≈ 0,003 QPS rata — 1 worker + Postgres kecil cukup. Storage: audit ±KB/event, <100 MB/thn/lokasi. Budget: webhook ACK p95 <3 dtk; worker lag <60 dtk. Scale 200 lokasi ≈ 0,6 QPS — masih 1 node + read replica bila perlu. Ukur ulang di pilot.

## 8. Failure Modes & Mitigation

Lihat resilience heatmap + pola konkret di Appendix D (WA down→SMS, kalender down→hold+antre PENDING_SYNC, retry storm→dedupe, LLM timeout→template deterministik).

## 9. Security & Privacy

STRIDE-lite + HMAC webhook + Vault refresh token + redaction ingestion + RLS (`03-Technical/06-Security-Privacy-Compliance.md`). PDP: ROPA, retensi 30-90 hari (OPEN), breach ≤72 jam.

## 10. Rollout Plan

M1-M5 build → pilot 1 lokasi 30 hari → gate (go/extend-60-hari/pivot-adapter). Rollback: redeploy artifact sebelumnya + migrasi down-bila-aman (RB-02). Canary = 1 lokasi dulu, bukan persen traffic.

## 11. Testing Strategy

Unit (guardrails, writer, verify, dedupe) + race simulation double-book + game-day webhook down + uji trigger eskalasi sintetis tiap 90 hari. Pendekatan di `05-Execution/02-MVP-Scope.md`.

## 12. Open Questions

1. Beachhead vertikal final (fisio/dental/salon)? 2. Retensi PII mentah 30/90 hari? 3. Simpan PHI AS (BAA) atau tidak? 4. Tarif WA IDR live + BSP pilihan?
