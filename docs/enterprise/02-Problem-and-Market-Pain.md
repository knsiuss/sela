# 02 — Problem and Market Pain

## 2.1 Core Problem Statement

[Fakta] Alur gagal bukan di pengiriman reminder, tapi di momen balasan: "bisa mundur jam 4?", "abis anter anak, Kamis aja". Tool 1-arah melempar semua deviasi ke manusia.
Source: https://www.bland.ai/blog/voice-ai-for-appointment-reminders-and-rescheduling, https://sakari.io/blog/best-sms-tools-for-appointment-reminders-7-platforms-compared-in-2026

Rantai: lupa → gagal reschedule cepat → miss call / after-hours voicemail → cancel jadi kursi kosong → staf burnout follow-up manual.

## 2.2 Quantified Pain Points

| Pain | Angka terverifikasi | Source |
|---|---|---|
| No-show rate | ~23% (105 studi); VA baseline 18.8%; MGMA median 6.81% 2023 (private practice mapan — beda setting) | Etisia, Clinekt, PMC |
| By vertical | Salon 15%, beauty 14%, dental 12%, klinik 18%, therapist 22%, chiro 16%, fitness 20%, vet 10%, legal 10%, home services 18% | https://www.etisia.com/no-show-statistics |
| Biaya per slot | $196 (Kheirkhah 2008) / ~$200 rule-of-thumb; $150B US/year = directional, unverifiable | Clinekt |
| Contoh salon | 25 appt/minggu x $65 x 15% = $31,187/tahun | Etisia |
| Contoh klinik | 30 appt/hari x 20% x $150 = $225,000/tahun | AppointmentReminder.com |
| Contoh salon kecil | 20 slot/hari x 20% x $75 = $300/hari = $72k/tahun | Rework |
| Lupa | 44% (phone interview), 36/100 (urban center), 33% (DialogHealth), 81% provider cite lupa (Tebra) | PMC, DialogHealth, Tebra |
| Missed call | 23% rata-rata, solo 30%+, 42% dari 7.000 call (22 praktik); dental 33% (8M conv), peak 68% unanswered | Greetmate/Talkdesk, notifyMD, TrueLark |
| After-hours | 41% call di luar 8-5; HVAC 42% after-hours, 60% unanswered; home-service 73% di luar 9-5 | Greetmate, ContractorInCharge, Hicira |
| Perilaku caller | 60% tutup jika hold >1 mnt (avg hold 4.4 mnt); 85% tidak call back; 62% ke kompetitor | DialogHealth, GetAira |
| Cancel | 5-30%; 81.3% dental: short-notice cancel barrier utama; waitlist auto isi 70-90% | DoctorConnect, Turnup, Curogram |
| Akses | 31% attrition karena lack timely availability; self-scheduling median no-show 1.8%; self-scheduling -29% no-show | DialogHealth |

## 2.3 Buyer Personas

- Clinic Owner / Practice Manager: peduli recovered revenue, staff hours, EHR sync, BAA.
- Dental / Physio / Salon Owner: peduli chair fill rate, waitlist refill menit, deposit policy, marketplace commission.
- HVAC / Field Service Owner: peduli speed-to-lead, dispatch, tiket after-hours $450-600 vs $275 siang, peak-season surge 200-425%.

## 2.4 Current Workarounds & Limitations

| Workaround | Limitasi |
|---|---|
| SMS blast YES/NO | Tidak parse bahasa bebas, tidak cek slot live |
| VoIP + manual callback | 40+ call pagi hari; headcount tidak scale after-hours |
| Denda $25-75 | Symptom fix; 68% pasien tetap datang walau mau cancel karena takut fee |
| Marketplace (Fresha/Mindbody ~20%) | Akuisisi oke, tapi fee scale mahal; bukan reschedule engine |
| Staf lembur / answering service generik | Voicemail tanpa booking = lost; tidak ada write-back |

## 2.5 Willingness to Pay Evidence

[Fakta] Emitrr $149/mo; Weave ~$249 + setup; NexHealth ~$350-400/location; Solutionreach $199-800; salon $25-350; HVAC $49-349; AI voice $0.25/mnt, Bland Build $299/mo. SMB sudah bayar rutin untuk kategori ini. Diferensiasi harus di outcome (recovered revenue), bukan fitur reminder.
