# 05 — Risk Register

> Skor = Dampak (1-5) × Probabilitas (1-5). Mitigasi menunjuk ke file/aksi konkret.

| ID | Risiko | Dampak | Prob | Skor | Mitigasi | Status |
|---|---|---|---|---|---|---|
| R-01 | Double-book di pilot | 5 | 3 | 15 | 3 lapis (hold TTL + single-writer re-validasi + EXCLUDE gist); simulasi race M4; 0 insiden = gate | Mitigasi jalan |
| R-02 | Template Meta ditolak/lambat | 4 | 3 | 12 | Submit M1; utility murni tanpa promo; fallback SMS | Open |
| R-03 | PMS GATED tak dapat write access | 4 | 3 | 12 | MVP = GCal; Open Dental bukti; PMS lain defer | Mitigasi jalan |
| R-04 | Biaya WA membengkak (rate card/BSP) | 3 | 3 | 9 | Kalkulator per-message M3; SMS-first; log pricing webhook | Open |
| R-05 | Cloud Firecrawl 429 menghambat riset | 2 | 4 | 8 | Self-host `:3002` hidup; batch kecil + jeda | Mitigasi jalan |
| R-06 | Scope creep multi-vertikal prematur | 4 | 3 | 12 | ADR adapter; beachhead 1; D-01 | Mitigasi jalan |
| R-07 | Churn pilot (ROI tak terlihat 30 hari) | 5 | 2 | 10 | Dashboard recovered revenue M3; gate N≥600 | Open |
| R-08 | PDP breach / PII bocor di log | 5 | 1 | 5 | Minimisasi + retensi 30-90 hari (keputusan open); ROPA; hapus saat churn | Open |

Review tiap gate fase. R-01 gagal = stop, perbaiki, jangan tambah fitur.
