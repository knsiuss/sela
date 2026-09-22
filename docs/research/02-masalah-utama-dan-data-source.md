# 02 — Masalah Utama yang Di-solve + Data Source

Fokus: reminder + reschedule otomatis untuk klinik, salon, HVAC, fisioterapi. AI baca balasan teks bebas, reschedule, follow-up tanpa manusia.

## 1. Lupa adalah penyebab no-show #1

Apa yang terjadi:
- Pasien/klien tidak ingat jadwal, tidak ada reminder efektif, atau reminder 1-arah tanpa aksi lanjut.

Data:
- 44% non-attendance karena lupa (telephone interview, dikutip narrative review PMC 2024).
- 36 dari 100 pasien lupa (urban academic medical center, PMC 2020).
- 33% pasien mengaku lupa (DialogHealth).
- 81% provider menyebut lupa sebagai penyebab top (Tebra 2026).
- Faktor pemicu versi RS: waiting lama, tidak ada reminder, manajemen jadwal inflexible, komunikasi buruk, relasi dokter-pasien lemah.

Source:
- https://pmc.ncbi.nlm.nih.gov/articles/PMC11102763/
- https://pmc.ncbi.nlm.nih.gov/articles/PMC7671744/
- https://www.dialoghealth.com/post/patient-no-show-statistics
- https://www.tebra.com/theintake/patient-experience/patient-scheduling-retention/stats-you-need-to-know-about-patient-cancellations-and-no-shows
- https://curogram.com/blog/why-patients-miss-appointments

Implikasi produk:
- Reminder H-24 + H-2 jam via SMS/WhatsApp dengan 1-tap confirm/cancel.
- Kalau tidak confirm, agent otomatis tawarkan reschedule, bukan diam.

## 2. Front-desk overload dan missed call

Apa yang terjadi:
- Telepon menumpuk di peak hour (Senin pagi, jam makan siang, sebelum tutup). Staf sibuk check-in, verifikasi asuransi, pasien onsite. Call kedua dan seterusnya nyangkut di hold/antrean voicemail.

Data:
- Rata-rata praktik miss 23% inbound call (Talkdesk). Solo/small group 30%+.
- 42% dari 7.000 call di 22 praktik miss (notifyMD).
- Peak staffing hanya cover 60% kebutuhan (DialogHealth).
- 60% pasien tutup telepon jika hold >1 menit; rata-rata hold 4.4 menit.
- 85% tidak call back setelah voicemail; 62% langsung hubungi kompetitor.
- SMB miss 62% call, rugi ~$126k/tahun.
- Dental miss 33% (analisis 8M percakapan); peak-hour 68% unanswered.
- 80% appointment masih di-schedule via telepon.

Source:
- https://www.greetmate.ai/blog/missed-calls-lost-patients-healthcare-revenue
- https://www.getaira.io/blog/missed-business-calls-statistics
- https://www.hicira.com/missed-call-statistics
- https://answernet.com/costs-of-missed-calls-in-medical-offices-and-how-to-avoid-them/
- https://www.demandforce.com/how-to-reduce-missed-calls/

Implikasi produk:
- Agent tangkap overflow + auto reply missed-call via teks dalam <1 menit.
- Jangan tambah headcount untuk masalah kapasitas sesaat.

## 3. After-hours gap — hampir setengah volume hilang

Apa yang terjadi:
- Pasien working-hour tidak bisa telpon jam kerja. Mereka telpon malam/weekend. Yang jawab voicemail generik tanpa kemampuan booking.

Data:
- 41% call pasien masuk di luar 8AM-5PM.
- 42% HVAC call dan 47% home-service inquiry terjadi after-hours.
- 73% home-service call di luar 9-5.
- 60% after-hours HVAC call unanswered.
- Kontraktor residensial terima 8-12 emergency call/minggu di luar jam kerja; tiket after-hours $450-600 vs $275 siang.
- 50% homeowner prefer telepon untuk scheduling HVAC vs 24% teks, 12% online booking.

Source:
- https://www.greetmate.ai/blog/missed-calls-lost-patients-healthcare-revenue
- https://contractorincharge.com/blog/missed-call-statistics-for-home-service-companies
- https://www.hicira.com/missed-call-statistics
- https://www.medicalofficeforce.com/how-missed-calls-cost-medical-practices-thousands-each-month/

Implikasi produk:
- Coverage 24/7 wajib untuk tangkap reschedule malam + emergency HVAC.
- Voicemail tanpa booking = lost revenue.

## 4. Cancel dan late-cancel jadi kursi kosong

Apa yang terjadi:
- Cancel terlihat kecil, tapi kursi kosong setelah cancel yang merugikan. Waitlist manual via telepon tidak sempat refill <15 menit.

Data:
- Cancel rate 5-30% tergantung specialty.
- 81.3% dental provider: short-notice cancel adalah barrier utama capai 100% kapasitas.
- Contoh: 4 cancel/hari x $200 = $800/hari hilang. Recover setengah via waitlist = $8.000/bulan selamat.
- Contoh lain: 30 pasien/hari x 20% no-show x $200 = $1.200/hari = $24k/bulan = $288k/tahun per provider.
- Klinik dengan waitlist otomatis klaim isi 70-90% last-minute cancel.
- Biaya per no-show: $196 (Kheirkhah 2008) / ~$200 rule-of-thumb; sistem US $150B/tahun (directional, unverifiable).

Source:
- https://doctorconnect.net/waitlist-management-solutions-fill-cancellations-fast
- https://curogram.com/blog/best-practices/appointment-management/reduce-patient-no-shows-strategies
- https://schedly.io/no-show-reduction-strategies-keep-your-schedule-full/
- https://www.turnup.world/strategic-dental-appointment-cancellation-recovery-a-2026-operational-guide/
- https://pmc.ncbi.nlm.nih.gov/articles/PMC11545362/
- https://clinekthealth.com/blog/average-no-show-rate-and-cost

Implikasi produk:
- Cancel link frictionless + blast waitlist otomatis + update jadwal tanpa staf.
- Metrik utama: slot recovery time dan % cancel terisi ulang.

## 5. Jadwal inflexible dan akses lambat bikin pasien kabur

Apa yang terjadi:
- Pasien tidak bisa geser jadwal dengan mudah, slot penuh, tidak ada opsi self-reschedule. Akhirnya ghosting atau pindah provider.

Data:
- 31% provider: lack of timely availability adalah penyebab utama patient attrition (DialogHealth).
- Online self-scheduling: median no-show 1.8% vs phone booking yang jauh lebih tinggi.
- Self-scheduling tool menurunkan no-show 29% (DialogHealth).
- Denda $25-75 (42% praktik AS 2025 terapkan) hanya perbaiki symptom; 68% pasien mengaku pernah datang padahal mau cancel karena takut fee.

Source:
- https://www.dialoghealth.com/post/patient-no-show-statistics
- https://insights.wchsb.com/2026/02/05/the-50-fee-wont-fix-a-50000-problem-why-medical-practices-must-rethink-their-no-show-strategy/
- https://curogram.com/blog/average-patient-no-show-rate

Implikasi produk:
- Self-reschedule via chat lebih efektif daripada denda.
- Tawarkan 2-3 opsi slot, konfirmasi eksplisit, update PMS real-time.

## Ringkasan rantai masalah

Lupa -> gagal reschedule cepat -> telepon miss / after-hours voicemail -> cancel jadi kursi kosong -> staf burnout follow-up manual -> revenue hilang + pasien pindah.

AI agent menang jika memutus rantai di tengah: tangkap balasan bebas kapan pun, rebook ke slot live, refill yang kosong dari waitlist, tanpa manusia.
