# 03 — Multi-Channel Strategy

> Disintesis dari subagent produk/channel (Firecrawl, 22 Sep 2026). Detail SoT ada di `01-Strategy/05-Product-Vision-and-Solution-Design.md`.

## Keputusan channel

| Channel | Peran | Alasan + SoT |
|---|---|---|
| WhatsApp | Primary booking + reminder interaktif | Konversi 45-60% vs 29% SMS; tombol Confirm/Reschedule; E2E. Batas: butuh app+internet, adopsi US lebih rendah. https://www.text-em-all.com/blog/sms-vs-whatsapp-for-business |
| SMS | Fallback wajib | Open 98%, jangkau 100% ponsel, $0,01-0,05/pesan. https://www.text-em-all.com/blog/sms-vs-whatsapp-for-business |
| Voice | Eskalasi terakhir | No-show risiko tinggi / 2x gagal confirm |
| Email | Tanda terima | Detail panjang saja |
| IG/Messenger/Web chat | Pendukung | Ikut orkestrasi yang sama, bukan mesin terpisah |

## Aturan biaya yang mengikat (2026)

- Per-message sejak 1 Jul 2025; hanya template terkirim ditagih. https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing
- 1 Okt 2026: utility + service dalam window BERBAYAR; free tier 1.000 service msg/bulan/nomor.
- Meta Business Agent: $2,00/juta token (≈4-5 sen/pesan) sejak 1 Agu 2026. https://www.useinvent.com/blog/meta-business-agent-what-it-is-and-the-alternative-you-own
- Reminder utility MURNI tanpa promo; satu promo = reklasifikasi marketing (6-9x) + butuh opt-in. https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-categorization

## Fallback otomatis

WA → SMS → voice. Minta preferensi channel saat intake. Pantau quality-rating + block rate di dasbor.
