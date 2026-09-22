# 02 — MVP Scope

> Keputusan D-03 + metrik dari `02-Product/05-Success-Metrics-and-KPIs.md`.

## In scope (0-3 bulan, target pilot-ready 3-5 minggu)

1. 1 nomor agent WhatsApp/SMS: confirm/cancel/reschedule teks bebas.
2. Slot-hold berwaktu + langkah konfirmasi eksplisit (anti double-book).
3. Tulis balik Google Calendar (idempotent + audit log).
4. Reminder utility MURNI T-48j/T-24j/T-2j + tombol Confirm/Reschedule.
5. Handoff operator ("ketik OPERATOR" + ringkasan chat) ikut 6 prinsip D-05.
6. Dasbor: fill rate, no-show delta vs baseline, recovery time, recovered revenue.
7. Opt-in/opt-out logging + kalkulator biaya per-message × negara.

## Out of scope V1

Promo dalam reminder; voice (eskalasi nanti); PMS vertikal kedua; outcome-based pricing; multi-location; Meta Business Agent sebagai mesin utama.

## Pilot gate (30 hari + baseline 7-14 hari)

Satu lokasi/beachhead 20-50 appt/hari. Go/no-go ikut metrik Success-Metrics (reduksi relatif ≥25-30%, fill ≥40-50%, confirm ≥60-70%, 0 double-book, time-to-fill <30 mnt, N≥600 + p<0,05). Gagal gate = extend 60 hari atau pivot adapter, bukan tambah fitur.
