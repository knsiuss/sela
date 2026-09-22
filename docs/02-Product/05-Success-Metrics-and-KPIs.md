# 05 — Success Metrics and KPIs

> Sumber: subagent deep-research metrik pilot (Firecrawl, 4 search + 3 scrape penuh: Clinekt, Zocdoc, ReadyToTalk; sisanya snippet). Klaim vendor = pitch, bukan janji.

## Go / No-Go pilot 30 hari (+ baseline audit 7-14 hari metode Zocdoc)

| Metrik | Target hari-30 | SoT |
|---|---|---|
| No-show delta | Reduksi relatif ≥25-30% dari baseline lokasi (bukan angka absolut vendor) | Literatur independen 28,9% otomatis / 39,1% live-call (Hasvold & Wootton via Clinekt): https://clinekthealth.com/blog/do-appointment-reminders-reduce-no-shows |
| Cancellation fill rate | ≥40-50% (menuju 50%+ hari-60, mature 70%+) | https://www.zocdoc.com/resources/blog/article/how-to-improve-patient-waitlist-management-and-fill-cancellations-faster/ |
| Confirmation rate | ≥60-70% (confirmed / reminders sent) | Target vendor 70%+: https://mybcat.com/blog/appointment-reminder-best-practices/ |
| Zero double-book | 0 insiden (safety gate, bukan benchmark) | Prinsip D-05 |
| Time-to-fill median | <30 menit (same/next-day) | Proxy Zocdoc, sumber sama di atas |
| Signifikansi | N≥600 appt (20/hari×30) + uji proporsi dua-sampel p<0,05, else extend 60 hari | Hitungan subagent, BUKAN benchmark bersumber |

## Benchmark acuan (konservatif, independen dulu)

- Baseline rata-rata ~23% across 105 studi (Dantas 2018 via Clinekt + PDF benchmark).
- Single-site: SMS 11,2% vs tanpa reminder 18,1% (~38% relatif); 3-arm 9.835 pasien: tanpa 23,1% vs otomatis 17,3% vs live-call 13,6%.
- Waitlist otomatis high-performer: fill 38,8% (IQR 36,2-45,7%); miss dari waitlist 3,1% vs 6,6%. https://pmc.ncbi.nlm.nih.gov/articles/PMC13395261/
- Biaya konservatif untuk ROI pitch: $200/missed healthcare, $85 salon, $200 home-service (ReadyToTalk). https://readyto.talk/blog/appointment-no-show-rates-by-industry/
- Klaim agresif (jangan jadi janji): ProactiveChart 40-65%, ReadyToTalk 135x ROI ($81.328/thn dental), Clinekt 12% volume lift.

## Baseline method (Zocdoc + Unify)

Audit tiap cancellation 1 minggu pre-go-live (cara masuk, siapa handle, lama slot kosong, terisi/tidak); kunci baseline human sebelum day-one; ukur 30/60/90 hari; run pada satu segmen.

## Uncertainty (tidak ditemukan — jangan klaim)

Confirmation rate tombol quick-reply vs teks bebas; CSAT/zero-double-book standar pilot; bukti WhatsApp-first ID/SEA vs SMS US (semua benchmark = SMS/voice US healthcare).

## Goal tree & status sukses (ditetapkan 23 Sep 2026)

North Star: **recovered revenue per lokasi per bulan > fee langganan** (ROI positif terukur, bukan vanity).

| Level | Metrik | MVP build (28 Okt) | Pilot (27 Nov) | PMF (Feb 2027) | Scale |
|---|---|---|---|---|---|
| L0 North Star | Recovered revenue/lokasi/bln | — (simulasi) | > fee (go) | ≥3x fee | ≥5x fee, NRR ≥100% |
| L1 Outcome | No-show reduksi relatif | — | ≥25-30% | ≥35% | ≥40% |
| L1 Outcome | Cancellation fill rate | terisi manual | ≥40-50% | ≥60% | ≥70% |
| L1 Safety | Double-book insiden | 0 (simulasi race) | 0 | 0 | 0 (stop-line tetap) |
| L1 Outcome | Time-to-fill median | — | <30 mnt | <15 mnt | <10 mnt |
| L2 Input | Confirmation rate | — | ≥60-70% | ≥70% | ≥75% |
| L2 Input | Reschedule completion tanpa manusia | E2E simulasi | ≥40% | >60% | >75% |
| L2 Input | Handoff rate | — | <30% | <20% | <15% |

Status sukses per fase:
- MVP sukses = typecheck + test hijau + race simulation 0 double-book + template approved.
- Pilot sukses = SEMUA gate L0+L1 hijau + N≥600 + p<0,05. Satu merah = extend 60 hari atau pivot adapter.
- PMF sukses = 20-50 lokasi + churn <5%/mo + reschedule completion >60%.
- Gagal = double-book berulang, atau 60 hari tanpa recovered revenue > fee di lokasi mana pun → stop/pivot, bukan tambah fitur.
