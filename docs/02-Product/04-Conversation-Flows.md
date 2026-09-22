# 04 — Conversation Flows

> Sumber: subagent deep-research conversation (Firecrawl 4 search + 5 scrape; Flows resmi + Nature snippet-level karena 429). Angka vendor = klaim pemasaran.

## 1. Pola dialog (produk nyata)

| Pola | Aturan | SoT |
|---|---|---|
| 4 langkah booking (Infobip): start via QR/ad/widget → pilih slot → tercatat CRM + konfirmasi → auto-reminder; jalur "live agent handover" eksplisit untuk eksepsi | Jangan putus workflow saat eskalasi | https://www.infobip.com/whatsapp-business/appointment-booking |
| Tombol deterministik untuk aksi kanonis | Maks 3 quick-reply ATAU 2 CTA per message; teks ≤20 char; >3 opsi → list (maks 10) | https://www.infobip.com/blog/how-to-use-whatsapp-interactive-buttons |
| Quick reply = ya/tidak/pilihan pendek; CTA = link/call eksternal; tiap tap di-tag untuk analitik | Label mulai kata kerja; uji multi-device; ukur delivery/seen/tap/CTR | sama di atas |
| Buttons + free-text (Megi/Infobip): tombol untuk aksi, teks bebas untuk input natural | CSAT 86% klaim vendor | sama di atas |
| Sesi 24 jam: di dalam user-initiated session boleh free-form tanpa template; business-initiated di luar wajib template | Desain reminder vs balasan beda aturan | https://whatsappbusiness.com/blog/whatsapp-flows-101/ (snippet) |
| Flows butuh endpoint cek availability real-time + konfirmasi | Tanpa itu bukan booking, cuma form | sama di atas |

Aturan builder: tombol = intent deterministik (tanpa NLU); teks bebas HANYA untuk tanggal/jam + alasan, selalu konfirmasi ulang slot kanonis (hari, tanggal, jam, zona) via tombol sebelum tulis.

## 2. Contoh alur reschedule (ID)

```text
Agent: Pengingat — kontrol gigi Kamis 25 Sep 15.30 dr. Ani. [Konfirmasi] [Geser] [Batal]
User: geser kamis sore aja (teks bebas)
Agent: Siap. Yang tersedia Kamis sore:
  1. Kamis 25 Sep 16.00 dr. Ani
  2. Kamis 25 Sep 17.30 dr. Budi
  [Pilih 1] [Pilih 2] [Hari lain] [Bicara staf]
User: [Pilih 1]
Agent: Konfirmasi pindah ke Kamis 25 Sep 16.00 dr. Ani? [Ya, pindahkan] [Batal]
User: [Ya, pindahkan]
Agent: Beres — sudah pindah. Balas OPERATOR kapan pun untuk staf.
```

## 3. HITL patterns (industri)

| Pola | Isi | SoT |
|---|---|---|
| Keputusan per-AKSI, bukan per-agen; 5 faktor: reversibility, blast radius, data sensitivity, confidence, domain | approve-before-act untuk high-risk; review-after-act untuk low-risk | https://www.arthur.ai/column/human-in-the-loop-governance-for-ai-agents |
| 3 sinyal: confidence + stakes + reversibility; contoh: refund HITL jika conf <95%, routing auto jika ≥80%; Safe Actions gate who/what/time-window (15 mnt, expire → cadangan) | Threshold vendor = contoh, BUKAN standar — kalibrasi dari trace sendiri | https://devrev.ai/blog/human-in-the-loop-ai |
| Operational triggers: conf <70% eskalasi; ≥3 input tak terparse berurutan; loop >8 mnt; "handoff record matters more than generated reply" | Timeout = deny by default; waspadai approver fatigue | HelpSquad: https://helpsquad.com/blog/ai-to-human-escalation-designing-handoffs-that-don-t-drop-the-patient/ |
| Rollout: minggu-1 100% HITL → HOTL → HOOTL berbasis data; EU AI Act syaratkan HITL + traceability untuk high-risk | Mulai 100% konfirmasi, longgarkan bertahap | DevRev sama di atas |

## 4. Deny-list eskalasi (hard-coded, bukan threshold)

Non-negotiable terlepas confidence: emergensi/nyeri dada/sesak/pingsan/stroke/anak gawat, krisis mental, obat terkontrol, identitas/asuransi tak terverifikasi, sengketa biaya/claim/prior-auth, permintaan manusia eksplisit → handoff + saran darurat, NOL respons bot tambahan. Pesan: "Saya hubungkan ke tim kami sekarang."
Paket konteks pra-connect: identitas, alasan kontak, transkrip timestamp, asuransi, alasan eskalasi, flag emosi. Fallback: nomor antrean + estimasi + callback. Uji trigger sintetis tiap 90 hari; drop-off >10% = masalah operasi.
SoT: HelpSquad sama di atas; Nature npj Digital Medicine https://www.nature.com/articles/s41746-026-03288-9 (snippet).

## 5. Indonesia informal (GAP riset — jangan invent mapping)

Ditemukan: dateparser dukung locale id (bukti formal, BUKAN chat informal) https://www.zyte.com/blog/parse-natural-language-dates-with-dateparser/; date-fns id: bulan formal + singkatan (Jan..Des) https://github.com/date-fns/date-fns/blob/717ce0a807ea4c6b540d015b5c408723175b283/pkgs/core/src/locale/id/snapshot.md; komunitas NLP ID kenal normalisasi kolokial https://github.com/irfnrdh/awesome-indonesia-nlp.
TIDAK ditemukan: mapping singkatan chat ("bsok", "senin dpn") atau benchmark entity resolution campur-kode. Desain: normalisasi → parse locale id → konfirmasi kanonis via tombol; ambiguitas → 1 pertanyaan klarifikasi + opsi tombol. Validasi dengan data chat nyata. Regulasi eskalasi chatbot kesehatan Indonesia: tidak ditemukan — praktik di atas = safety baseline, bukan kewajiban hukum.
