# 02 — Problem Definition and Market Pain

> Semua angka di bawah wajib punya Source of Truth (kolom SoT). Tanpa SoT = [Asumsi], tidak boleh dipakai untuk keputusan.

## 2.1 Core Problem Statement

Rantai gagal: lupa → gagal reschedule cepat → miss call / after-hours voicemail → cancel jadi kursi kosong → staf burnout follow-up manual.

| Klaim | SoT |
|---|---|
| Reminder tools umumnya broadcast 1-arah; momen balasan ("bisa mundur jam 4?") dilempar ke manusia | https://www.bland.ai/blog/voice-ai-for-appointment-reminders-and-rescheduling |
| Platform kuat me-routing "RESCHEDULE" ke flow slot, bukan inbox generik; yang lemah hanya notifikasi | https://sakari.io/blog/best-sms-tools-for-appointment-reminders-7-platforms-compared-in-2026 |
| Praktik kirim 200 SMS/hari tetap terima 40+ inbound reschedule call; no-show 5-30% persisten walau reminder jalan | https://www.bland.ai/blog/voice-ai-for-appointment-reminders-and-rescheduling |

## 2.2 No-show rate & biaya (SoT per angka)

| Metrik | Angka | SoT |
|---|---|---|
| Rata-rata global | ~23% dari 105 studi (Dantas et al., Health Policy 2018) | https://www.etisia.com/no-show-statistics |
| Baseline 10 klinik VA, 12 tahun | 18.8% (Kheirkhah et al., BMC 2016) | https://www.etisia.com/no-show-statistics |
| No-show + cancel sampel ~45rb pasien | 31.1% | https://www.bland.ai/blog/voice-ai-for-appointment-reminders-and-rescheduling |
| Median private practice mapan AS 2023 | 6.81% (beda setting vs 23% global, bukan error ukur) | https://clinekthealth.com/blog/average-no-show-rate-and-cost |
| Biaya per slot | $196 (Kheirkhah 2008 USD) / rule-of-thumb $200 | https://clinekthealth.com/blog/average-no-show-rate-and-cost |
| Klaim $150B/tahun US healthcare | Directional, unverifiable — jangan untuk business case | https://clinekthealth.com/blog/average-no-show-rate-and-cost |
| Efektivitas reminder | SMS naikkan attendance vs tanpa reminder, setara phone call (Cochrane Gurol-Urganci 2013) | https://www.etisia.com/no-show-statistics |
| Open rate | SMS 95-98% vs email 20-35% | https://resources.rework.com/libraries/beauty-center-growth/automated-appointment-reminders |
| Reduksi via reminder | 30-60% (agregator, perlakukan sebagai range) | https://appointmentreminder.com/guides/no-show-statistics/ |

Rate per vertikal (Etisia 2026 planning range, directional):

| Vertikal | Rate | SoT |
|---|---|---|
| Hair salon/barber | 15% | https://www.etisia.com/no-show-statistics |
| Beauty/nail | 14% | https://www.etisia.com/no-show-statistics |
| Dental | 12% | https://www.etisia.com/no-show-statistics |
| Medical/klinik | 18% | https://www.etisia.com/no-show-statistics |
| Therapist/counselor | 22% | https://www.etisia.com/no-show-statistics |
| Chiropractor | 16% | https://www.etisia.com/no-show-statistics |
| Fitness/gym | 20% | https://www.etisia.com/no-show-statistics |
| Vet / legal | 10% | https://www.etisia.com/no-show-statistics |
| Home services | 18% | https://www.etisia.com/no-show-statistics |
| Real estate showing | 20% | https://www.etisia.com/no-show-statistics |

Contoh biaya (verifikasi hitung sendiri dari rate di atas):

| Skenario | Hitungan | SoT formula |
|---|---|---|
| Salon 25 appt/minggu, $65, 15% | $31,187/tahun | https://www.etisia.com/no-show-statistics |
| Praktik 30 appt/hari, 20%, $150 | $225,000/tahun | https://appointmentreminder.com/guides/no-show-statistics/ |
| Salon 20 slot/hari, 20%, $75 | $300/hari = $72k/tahun | https://resources.rework.com/libraries/beauty-center-growth/automated-appointment-reminders |
| Provider 30 pasien/hari, 20%, $200 | $1,200/hari = $24k/bulan = $288k/tahun | https://curogram.com/blog/best-practices/appointment-management/reduce-patient-no-shows-strategies |

## 2.3 Alasan miss — lupa #1 + friksi sistemik

| Klaim | SoT |
|---|---|
| 44% non-attendance karena lupa (phone interview, dikutip narrative review) | https://pmc.ncbi.nlm.nih.gov/articles/PMC11102763/ |
| 36/100 pasien lupa (urban academic center) | https://pmc.ncbi.nlm.nih.gov/articles/PMC7671744/ |
| 33% pasien ngaku lupa | https://www.dialoghealth.com/post/patient-no-show-statistics |
| 81% provider sebut lupa penyebab top | https://www.tebra.com/theintake/patient-experience/patient-scheduling-retention/stats-you-need-to-know-about-patient-cancellations-and-no-shows |
| Pemicu sistemik: waiting lama, no reminder, jadwal inflexible, komunikasi buruk | https://pmc.ncbi.nlm.nih.gov/articles/PMC11102763/ |
| 31% provider: lack timely availability = penyebab attrition | https://www.dialoghealth.com/post/patient-no-show-statistics |
| Self-scheduling median no-show 1.8%; self-scheduling -29% no-show | https://www.dialoghealth.com/post/patient-no-show-statistics |
| 42% praktik AS terapkan denda (MGMA Jan 2025, 622 groups), $25-75; hanya symptom fix | https://clinekthealth.com/blog/average-no-show-rate-and-cost + https://insights.wchsb.com/2026/02/05/the-50-fee-wont-fix-a-50000-problem-why-medical-practices-must-rethink-their-no-show-strategy/ |

## 2.4 Missed call & after-hours gap

| Klaim | SoT |
|---|---|
| Miss 23% rata-rata; solo/small 30%+ | https://www.greetmate.ai/blog/missed-calls-lost-patients-healthcare-revenue |
| 42% dari 7.000 call di 22 praktik miss | https://answernet.com/costs-of-missed-calls-in-medical-offices-and-how-to-avoid-them/ |
| 41% call masuk di luar 8AM-5PM | https://www.greetmate.ai/blog/missed-calls-lost-patients-healthcare-revenue |
| Peak staffing hanya cover 60% kebutuhan | https://www.greetmate.ai/blog/missed-calls-lost-patients-healthcare-revenue |
| 60% tutup jika hold >1 mnt; rata-rata hold 4.4 mnt | https://www.greetmate.ai/blog/missed-calls-lost-patients-healthcare-revenue |
| 85% tidak call back; 62% ke kompetitor | https://www.getaira.io/blog/missed-business-calls-statistics |
| SMB miss 62%, rugi ~$126k/tahun | https://www.getaira.io/blog/missed-business-calls-statistics |
| Dental miss 33% (8M conv); peak 68% unanswered | https://www.hicira.com/missed-call-statistics |
| 80% appointment masih via telepon | https://answernet.com/costs-of-missed-calls-in-medical-offices-and-how-to-avoid-them/ |
| HVAC miss 71% saat peak; $1.200/missed call; $50k+/tahun | https://contractorincharge.com/blog/missed-call-statistics-for-home-service-companies |
| 42% HVAC call after-hours, 60% unanswered; home-service 73% di luar 9-5 | https://contractorincharge.com/blog/missed-call-statistics-for-home-service-companies + https://www.hicira.com/missed-call-statistics |
| Tiket after-hours $450-600 vs $275 siang; 50% prefer telepon vs 24% teks | https://www.hicira.com/missed-call-statistics |

## 2.5 Cancel → kursi kosong, waitlist penentu

| Klaim | SoT |
|---|---|
| Cancel rate 5-30% by specialty | https://doctorconnect.net/waitlist-management-solutions-fill-cancellations-fast |
| 81.3% dental: short-notice cancel barrier utama kapasitas | https://www.turnup.world/strategic-dental-appointment-cancellation-recovery-a-2026-operational-guide/ |
| Waitlist otomatis klaim isi 70-90% last-minute cancel | https://doctorconnect.net/waitlist-management-solutions-fill-cancellations-fast |
| 4 cancel/hari x $200 = $800/hari; recover setengah = $8k/bulan | https://curogram.com/blog/best-practices/appointment-management/reduce-patient-no-shows-strategies |
| Setiap slot kosong = £120 (NHS Scotland) sebagai pembanding | https://pmc.ncbi.nlm.nih.gov/articles/PMC11545362/ |

## 2.6 Buyer personas (interpretasi dari fakta di atas)

- Clinic manager: recovered revenue + EHR sync + BAA.
- Salon owner: chair fill + refill menit + komisi marketplace.
- HVAC owner: speed-to-lead + dispatch + tiket after-hours.

## 2.7 Willingness-to-pay evidence

| Bukti | SoT |
|---|---|
| Emitrr $149/mo; Weave ~$249 + $750 setup; NexHealth ~$350-400/location; Solutionreach $199 list / $400-800 reported | https://practicesignal.com/dental/compare/weave-vs-nexhealth-vs-solutionreach + https://noshowcost.com/tools/solutionreach-pricing |
| Salon $25-350; HVAC $49-349; ServiceTitan custom premium | https://bookingpro.ai/blog/best-salon-software-2026/ + https://fieldservicesoftware.io/comparisons/housecall-pro-vs-jobber-vs-servicetitan/ |
| AI voice $0.25/mnt; Bland Build $299/mo | https://www.bland.ai/blog/voice-ai-for-appointment-reminders-and-rescheduling |

## 2.8 Suplemen deep-research (22 Sep 2026, subagent problem/pain)

Status: F1-F9 = terverifikasi via scrape/baca halaman; A1-A7 = agent-reported, directional, spot-check sebelum kunci math pasar/pricing.

Fakta terverifikasi:
- F1. No-show lintas-spesialis AS: dental 15%, primary care 19%, OB/GYN 18%, peds 30%, derm 30%, optometry 25%, neuro 26%; nilai kunjungan $125-350/slot. https://www.solutionreach.com/blog/which-wins-the-national-average-no-show-rate-or-yours-1
- F2. Survei Polandia 2025 (n=1162, peer-review Med Sci Monit 2026): 14% mangkir tanpa cancel; lupa 42,3%, hambatan komunikasi 27,5%; dukung SMS reminder 62,5%; dukung denda 67,5%. https://pmc.ncbi.nlm.nih.gov/articles/PMC12961910/
- F3. Salon/wellness UK (Fresha, Feb 2026): 8% bisnis TIDAK PERNAH kena cancel; 30% kena 1-2x/minggu, 14% ≥3x/minggu; 62% cancel notice <24 jam; sakit 47%, jadwal kerja 38%, lupa 22%. Ini FREKUENSI, bukan % no-show. https://www.fresha.com/blog/cancellations-cost-study
- F4. Home services: ~27% inbound call tak terjawab; ~$1.200 revenue hilang per missed call (Invoca via HCP; nilai lead/lifetime, bukan harga slot). https://www.housecallpro.com/resources/missed-calls
- F5. Healthcare calls (Invoca 2021, primer): 29% unanswered (dental 37%, RS 36%, specialty 36%, medis 31%, primary 24%); CPL $162; 74% tutup saat hold. https://www.invoca.com/infographics/the-cost-of-missed-appointment-calls-for-healthcare-marketers
- F6. SMB calls: ~50% tak terjawab; hanya 20% tinggalkan voicemail (Weave blog, footnote pihak-3). https://www.getweave.com/call-queue-does-my-business-need-it-if-i-have-missed-call-text
- F7. RCT SMS tambahan: no-show primer RR 0,93, mental-health ~0,89, same-day cancel 0,94 (PMC9126539). RCT SMS vs telpon: telpon 9,5% vs SMS 21% vs kontrol 22,8% — telpon > SMS untuk risiko-tinggi (pmid:34120122).
- F8. NHS ~7,2 jt janji GP mangkir/thn ≈ £216 jt (PMC7716879); paliatif AS: 396 no-show dihindari ≈ $79.200/thn ≈ $200/kunjungan (pmid:32845702).
- F9. Lupa lintas-studi 12-42% (Oman 12,1%; Turki 20,7%; Polandia 42,3%); konflik jadwal 16,5%; "tidak tahu punya janji" 22%; VA primary care: no-show 3,87%, cancel pasien 3,92%.

Agent-reported (butuh spot-check): benchmark klinik ~18%, dental 15-20%, salon 3% + cancel 8% (Zenoti, platform ber-deposit), medspa no-show 4-5% + cancel 14-16%, HVAC ~18%; after-hours HVAC 35-40% (pakai ini; 73% outlier definisi); unanswered after-hours 60%; waitlist otomatis median fill 38,8%, miss 3,1% vs 6,6% (JMIR 2026); denda klinik $25-100 (~$50), medspa forfeit 100%/deposit $50-100; late-cancel dental 8-12%.

Konflik & aturan pakai:
- Zenoti 3-5% (dengan card-on-file/deposit) vs Fresha 92% bisnis rutin kena cancel — metrik beda (rate vs frekuensi). Ekspektasi: rate rendah HANYA dengan deposit/garansi kartu.
- Pisahkan "no-show JANJI" vs "unanswered CALL" — Invoca 24-37% adalah call.
- Gap belum tertutup: % caller tak terjawab yang tidak call back/pindah kompetitor; no-show rate FISIO spesifik (jangan kutip angka); cancel rate umum non-dental/medspa.
- Semua angka AS/UK 2021-2026 — transfer ke Indonesia tidak 1:1.
