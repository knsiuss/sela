# Design Doc / RFC Template

> Copy ke `docs/rfcs/NNNN-judul.md` dan isi. Hapus panduan kurung ini saat pakai.

```text
Title:
Author:
Status: Draft / In Review / Approved / Deprecated
Reviewers:
Date:
```

## 1. Summary (TL;DR)

2-3 kalimat: apa yang dibangun dan kenapa. Reviewer yang cuma baca ini harus paham.

## 2. Context & Problem Statement

Pain point + data/metrik (bukan "kayaknya"). Tanpa masalah konkret, tak perlu design doc.

## 3. Goals

Measurable. Bukan "improve performance" tapi "P99 X→Y".

## 4. Non-Goals

Eksplisit apa yang TIDAK dikerjakan. Perisai scope creep + pertanyaan reviewer.

## 5. Proposed Design

- High-level architecture (C4 L1 diagram)
- Component breakdown (C4 L2/L3)
- Data model / ERD
- API contract (endpoint, shape, error)
- Sequence flow (critical path async/multi-step)

## 6. Alternatives Considered

| Alternatif | Pros | Cons | Kenapa ditolak |
|---|---|---|---|
| | | | |

## 7. Scalability & Performance

Back-of-envelope: QPS proyeksi, storage growth/bln, latency budget per komponen.

## 8. Failure Modes & Mitigation

Apa rusak → blast radius → mitigasi/fallback.

## 9. Security & Privacy

Auth model, data sensitivity, akses. Singkat bila bukan fintech/health.

## 10. Rollout Plan

Phased, feature flag, canary, ROLLBACK PLAN (wajib).

## 11. Testing Strategy

Unit/integration/load — approach, bukan detail case.

## 12. Open Questions

Jujur tulis yang belum tahu.
