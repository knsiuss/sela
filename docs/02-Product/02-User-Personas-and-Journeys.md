# 02 — User Personas and Journeys

> Sumber: subagent deep-research personas (Firecrawl 3 search + 3 scrape; 2 search + 1 scrape Reddit gagal 429/unsupported). Klaim vendor ≠ fakta independen. GAP ditandai eksplisit.

## 1. Tabel persona

| Persona | Goals | Pains | Kriteria beli | WTP signal |
|---|---|---|---|---|
| P1 Clinic/practice owner (dental, fisio, allergy) | Turunkan no-show; lindungi revenue/slot; continuity of care | No-show 5-10% (spesialis 30%+); ~$200/slot; 5/minggu ≈ $52rb/thn; pasien baru + lead time panjang paling rawan | Konfirmasi 2-arah, booking ≥48 jam, waitlist same-day, kebijakan tertulis, integrasi kalender/portal | Rugi $50-150rb/thn → langganan puluhan-ratusan $/bln terjustifikasi [INTERPRETASI] |
| P2 Salon owner (chair-based) | Kursi penuh; rebooking cepat; deposit/komitmen | 1 jam stylist hilang tak tergantikan; last-minute sulit diisi | Online booking + self reschedule, reminder otomatis, no-show tracking + deposit, histori klien, value-for-money | Entry $7-35/bln s.d. $125-175/bln; Fresha gratis + fee/klien baru [FAKTA Capterra]. Zenoti 18%/72% = klaim vendor |
| P3 HVAC owner (1-10 teknisi) | Jawab tiap panggilan; booking ke jadwal; tangkap emergency + peak | 27% missed (62% SMB jam kerja; 71% peak); 42% after-hours; 80% tutup tanpa voicemail; 85% tak balik; single point of failure; spike 200-425% | Jawaban 24/7 <5 mnt, booking ke ServiceTitan/HCP, kualifikasi lead, emergency routing, sinkron CRM | ~$1.200/missed call; rugi $50-60rb/thn [klaim vendor CIC, bukan studi independen] |
| P4 Front-desk/dispatcher | Isi slot batal cepat; kurangi telepon bolak-balik; data rapi | Kumpulkan 2+ kontak/registrasi; konfirmasi H-2 + H-2 jam; follow-up ≤48 jam empatik; catat 8 field; SPOF saat peak | Otomatisasi 2-arah, skrip "confirm", template denda $50/deposit, waitlist | Tidak bayar sendiri — ukur dari hemat jam + retensi [INTERPRETASI] |
| P5 End customer | Booking/reschedule luar jam kerja; tanpa antre; paham perlunya follow-up | Lupa, bingung follow-up, takut diagnosis/biaya, transport/childcare; 37% ulasan bintang-1 soal unresponsiveness | Respon tercepat (78% sewa yang pertama jawab); channel pilihan; 3 sentuhan (booking, H-7, H-1/2); kebijakan adil | Fee $25-100 (~$50) tapi jarang dibayar + animositas; Medicaid larang di bbrp state [FAKTA ACAAI/Curogram]. Salon: deposit > denda pasca [INTERPRETASI] |

## 2. Journey per persona (ringkas)

- P1 klinik: book jauh hari (risiko tertinggi) → reschedule via telepon/manual → late cancel <24 jam = no-show (definisi ACAAI) → follow-up ≤48 jam empatik + reschedule + ingatkan deposit → after-hours tak terjawab = pindah ke ED → fee dispute: three-strikes/deposit, bukan denda kaku.
- P2 salon: book online + deposit → self-reschedule portal (tanpa itu = telepon saat stylist sibuk) → reminder otomatis → tandai no-show + waitlist → booking malam via portal → deposit menekan sengketa.
- P3 HVAC: telepon saat darurat (78% sewa penjawab pertama; web form 1/10-1/15 vs telepon) → teknisi tertunda butuh de-eskalasi + geser → cancel saat peak = $1.200+ → bisnis-terlambat callback ≤5 mnt → after-hours 42-47%, voicemail = kuburan lead, emergency routing → komplain soal responsivitas merusak SEO lokal.
- P4 front-desk: kumpulkan kontak + preferensi → tawarkan slot same-day + short-notice list → telepon ≤48 jam + 8 field → alihkan after-hours → kebijakan fleksibel + hardship exception.
- P5 customer: pilih channel → konfirmasi aktif ("Reply C") kalahkan alert pasif (Atlas 14,2%→4,91% klaim vendor) → 3 sentuhan + self-serve → klaster lupa/takut/biaya/transport → darurat cari jawaban langsung → tolak denda kaku.

## 3. Beda perilaku per vertikal

| Dimensi | Salon | Dental/klinik | HVAC | Fisio |
|---|---|---|---|---|
| Lead time | Rutin 2-8 minggu, booking pendek | Recall 6 bln, lead panjang = lupa (OR 5,45 >4 minggu) | Spike musiman, 8 peak weeks = 34% call | Episode mingguan; risiko "merasa membaik lalu batal" [INTERPRETASI, GAP sumber] |
| Unit hilang | 1 jam stylist + komisi | 1 slot $200 + overhead + value-based metrics | 1 call $1.200 + LTV maintenance + referral | 1 sesi + putus episode care [GAP] |
| Komitmen | Deposit + histori | Agreement + deposit repeat-offender + three-strikes | Kecepatan <5 mnt + live agent | Adherence + pengingat sesi [GAP] |
| After-hours | Portal 24/7 (GAP angka) | Pindah ke ED/urgent care | 42-47%, routing darurat | Rendah; SMS malam [GAP] |
| Sengketa | Deposit, rendah | Denda pasca bermusuhan; waspadai Medicaid | Soal responsivitas/estimasi | Sensitif biaya × sesi [GAP] |

## Implikasi builder

Klinik/salon: konfirmasi 2-arah 3-sentuhan + self-reschedule + waitlist same-day + deposit fleksibel. HVAC: jawab <5 mnt 24/7 + booking ke job scheduler + emergency routing. Fee: first-time forgiveness / three-strikes / deposit repeat-offender, bukan denda kaku. Validasi lanjutan: 5-8 wawancara front-desk per vertikal + audit log 30 hari sebelum pricing.

## Sources

- https://curogram.com/blog/average-patient-no-show-rate
- https://education.acaai.org/patient-no-shows
- https://contractorincharge.com/blog/missed-call-statistics-for-home-service-companies
- https://www.capterra.com/resources/salon-software-pricing-report/
- https://pmc.ncbi.nlm.nih.gov/articles/PMC11149957/
- https://www.capterra.com/p/141697/Salonized/
- https://www.mis-solutions.com/2026/01/hvac-scheduling-and-dispatch/
