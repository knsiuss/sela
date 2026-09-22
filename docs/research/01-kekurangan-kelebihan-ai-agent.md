# 01 — AI Agent untuk Reminder + Reschedule Otomatis: Kelebihan vs Kekurangan

Konteks: klinik, salon, HVAC, fisioterapi. Job: baca balasan teks bebas, reschedule, follow-up tanpa manusia.

## Kelebihan

### 1. Menutup gap reschedule callback
Tools reminder generik hanya broadcast 1-arah. AI agent bisa parse intent bebas ("mundur jam 4?", "abis anter anak") lalu cek slot live dan rebook dalam 1 percakapan. Ini sumber no-show 5-30% yang persisten walau reminder sudah jalan.

### 2. After-hours coverage
40+ call reschedule sering masuk pagi hari dari SMS yang dikirim sore/malam. Agent SMS/voice 24/7 mencegah slot blocked yang jadi no-show semu.

### 3. Waitlist refill cepat
Nilai terbesar bukan reminder, tapi isi slot cancel <15 menit dari waitlist. Agent bisa blast + negosiasi + konfirmasi otomatis, tidak menunggu staf pagi.

### 4. Tangani percakapan cascade
1 kontak sering jadi 3 job: reschedule + cek rujukan/asuransi + booking lain. Agent dengan akses PMS/CRM bisa selesaikan sekaligus, tool keyword YES/NO langsung gagal.

### 5. Turunkan beban FTE tanpa ganti sistem telepon
Untuk SMB, agent SMS-first bisa jalan di atas PMS existing (Open Dental, Mangomint, Jobber). Tidak perlu rip-and-replace VoIP seperti Weave ($750 setup, 2-4 minggu).

## Kekurangan

### 1. Risiko double-booking dan write-back
Tanpa sync 2-arah yang dalam ke PMS/kalender (durasi, buffer, room/chair/teknisi), agent hallucinasi slot. Ini failure mode paling mahal: 1 double-book menghancurkan trust.

### 2. NLU bahasa informal + negosiasi
"Siangan dikit", "habis Dzuhur", "minggu depan aja" butuh entity resolution tanggal/jam + preferensi provider. Keyword flow gagal, LLM mentah juga gagal kalau tidak ada guardrail slot dan konfirmasi eksplisit.

### 3. Compliance dan data
Klinik butuh HIPAA/BAA, SSO, data residency, audit log, export saat churn. Weave/NexHealth tidak publish export policy saja sudah jadi masalah; AI agent baru akan ditanya lebih keras.

### 4. Biaya dan latensi voice
Voice AI ($0.25/menit, Bland Build $299/mo untuk 2.000 call/hari) mahal untuk volume reminder harian. Stack 5-vendor (STT-LLM-TTS-telephony-CRM) gagal diam-diam saat burst Senin pagi kalau tidak di-load-test.

### 5. Over-automation untuk edge case sensitif
Keluhan, sengketa biaya no-show ($25-75), pasien sensitif, teknisi HVAC darurat — full-auto tanpa eskalasi manusia menaikkan churn. Butuh confidence threshold + handoff.

### 6. CAC dan trust SMB
SMB bayar $149-500/mo tapi churn cepat kalau 30 hari pertama tidak terlihat recovered revenue. Demo suara bagus tidak cukup; yang diuji adalah reschedule completion rate.

## Kapan Pakai vs Tidak

Pakai AI agent jika:
- Volume reschedule manual >20/minggu dan ada waitlist.
- Punya 1 integrasi PMS yang bisa write-back real-time.
- Punya data slot, durasi, dan aturan cancel yang jelas.

Jangan full-auto jika:
- Belum ada slot source-of-truth tunggal.
- Vertikal butuh BAA tapi kamu belum siap audit.
- Belum ada metrik recovered revenue dan handoff manusia.

## Implikasi Build

MVP aman: SMS-first, 1 vertikal + 1 PMS, scope reschedule + cancel + waitlist refill saja. Voice dan multi-vertikal setelah write-back stabil dan eskalasi jelas.
