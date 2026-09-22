# 05 — Product Vision and Solution Design

> Sumber: subagent deep-research produk/channel (Firecrawl, 22 Sep 2026) + riset sesi ini. Label [Fakta]/[Interpretasi]/[Asumsi] wajib.

## 5.1 Vision

Agen resepsionis 24/7 yang menyelesaikan booking/reschedule dalam 1 percakapan — bukan sekadar pengingat.

## 5.2 Fakta pengikat (SoT)

| Fakta | SoT |
|---|---|
| Harga WhatsApp = per-message sejak 1 Jul 2025; hanya template terkirim yang ditagih; tarif per kategori x country code | https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing |
| Non-template dalam open service window gratis (sejak 1 Nov 2024); utility template dalam window gratis (sejak 1 Jul 2025); FEP 72 jam dari Click-to-WhatsApp ads gratis | https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing |
| 1 Okt 2026: utility dalam window JADI BERBAYAR; service message (balasan manusia/AI pihak ketiga) JADI BERBAYAR per-message setara utility/auth; sisa free tier 1.000 service msg/bulan/nomor | https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing + https://www.wati.io/en/blog/whatsapp-api-pricing-guide/ |
| Kategori template: Marketing / Utility / Authentication; campuran utility+marketing = marketing; utility bermuatan promo di-approve sebagai MARKETING (9 Apr 2025); penyalahgunaan → restriksi bertingkat | https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-categorization |
| Orde tarif 2026 (sekunder, WAJIB cek rate card resmi): Marketing ≈ $0,03 AS / $0,0103 India / $0,0625 Brasil / $0,05 UK; Utility/Auth ≈ $0,0034 AS / $0,0014 India; BSP tambah platform fee; marketing tanpa volume discount | https://www.wati.io/en/blog/whatsapp-api-pricing-guide/ |
| SMS: open 98% (90% <3 mnt), jangkau 100% ponsel, $0,01-0,05/pesan; WhatsApp: konversi 45-60% vs 29% SMS, E2E, tapi butuh app+internet, broadcast open ~58%, adopsi US lebih rendah | https://www.text-em-all.com/blog/sms-vs-whatsapp-for-business |
| Angka "$0,005-0,05 per conversation" di halaman itu STALE (pra-Jul-2025) — JANGAN dipakai | (catatan subagent, 22 Sep 2026) |
| Reminder: SMS dan WhatsApp sama-sama open 90%+, WhatsApp response/confirmation jauh lebih tinggi; sekuens 3-tahap (48j/24j/2j) pola umum; praktik 20-50 pasien/hari habis "well under $50/month" untuk utility template (snippet-level, sinyal bukan kutipan final) | https://dendoo.lv/blog/sms-vs-whatsapp-vs-email-best-appointment-reminders-for-dental-clinics-in-africa/ + https://www.codewords.ai/blog/whatsapp-vs-sms-for-dental-appointment-reminders + https://cogniqai.ai/blog/automated-reminders-sms-vs-email-vs-whatsapp-2026 |
| Meta Business Agent: GA global 3 Jun 2026; gratis s.d. 1 Agu 2026 lalu $2,00/juta token (≈4-5 sen/pesan); GCal view+edit + GDrive knowledge (sync ≤12 jam) live; TERBATAS pasar/bahasa; market-research masih waitlist; bot general-purpose dilarang (enforcement 15 Jan 2026) | https://www.useinvent.com/blog/meta-business-agent-what-it-is-and-the-alternative-you-own + https://chatmaxima.com/blog/meta-business-agent-platform-explainer-2026/ + https://upperfloor.ai/en/blog/meta-policy-ai-agents |
| Marketing template wajib opt-in + approval; satu promo dalam utility = reklasifikasi ke marketing + tarif marketing + risiko quality-rating | https://www.auditsocials.com/blog/whatsapp-business-marketing-message-compliance-2026-opt-in-template-categories-per-message-pricing-meta |

## 5.3 Channel strategy (rekomendasi subagent)

WhatsApp = primary booking + reminder interaktif (tombol Confirm/Reschedule) di pasar WhatsApp-heavy. SMS = fallback wajib reminder kritis + pelanggan tanpa WhatsApp. Voice = eskalasi terakhir (no-show risiko tinggi / 2x gagal confirm). Email = tanda terima saja. Minta preferensi channel saat intake.

## 5.4 MoSCoW V1

- MUST: booking flow slot-hold berwaktu + konfirmasi eksplisit anti double-book; reminder utility MURNI tanpa promo (T-48j/T-24j/T-2j) + tombol; human handoff ("ketik OPERATOR" + ringkasan chat); opt-in/opt-out logging; kalkulator biaya per-message x negara.
- SHOULD: reschedule/cancel mandiri dalam chat; no-show scoring → eskalasi SMS/voice; daily digest staf; dasbor quality-rating + block rate.
- COULD: Click-to-WhatsApp ads (manfaatkan FEP 72 jam); pesan pasca-kunjungan (review/recall) sebagai marketing terpisah ber-opt-in.
- WON'T V1: promo dalam reminder transaksional; Meta Business Agent sebagai satu-satunya mesin; general-purpose chatbot (dilarang Meta).

## 5.5 Diferensiasi vs Meta Business Agent

1. Deep calendar/PMS vertikal (durasi, staf, buffer, double-book guard) vs konektor GCal generik.
2. Orkestrasi multi-channel otomatis (WA→SMS→voice) vs WA-only.
3. Pasar/bahasa + nomor sendiri tanpa gate eligibility Meta.

## Batasan riset ini

- 3 kueri tambahan gagal (rate-limit 429): klaim snippet-level di atas = sinyal, bukan kutipan final.
- Klaim "WhatsApp-first untuk SEA" BELUM terbukti — butuh 1 sumber penetrasi (DataReportal/GSMA).
- Tarif $ = sekunder — cek rate card resmi per country code sebelum pricing ke pelanggan.
- Aturan 1 Okt 2026 per 22 Sep 2026 = 9 hari lagi — verifikasi ulang halaman pricing resmi saat implementasi.
