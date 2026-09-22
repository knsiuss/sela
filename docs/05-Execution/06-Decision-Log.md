# 06 — Decision Log

> Keputusan terkunci dari sesi grill 22 Sep 2026. Yang belum diputus ditandai OPEN.

## D-01: Multi-vertikal sebagai platform, bukan satu field (TERKUNCI arah)

Keputusan: bangun core engine vertikal-agnostik (NLU slot, slot-hold + konfirmasi, waitlist refill, handoff) + adapter per vertikal (PMS, aturan durasi/resource, template bahasa). Hotel dan layanan lain = adapter berikutnya, bukan scope awal.
Alasan: write-back terpercaya dan aturan slot beda per PMS — itu yang diteliti sebagai moat. Satu beachhead dulu untuk buktikan trust, lalu tambah adapter. Lawan argumen "langsung semua": tiap PMS butuh mapping + testing; sekaligus = double-book di semua vertikal.
Status: beachhead spesifik masih OPEN (kandidat: fisio / dental boutique / salon).

## D-02: Channel dievaluasi dari unit economics, bukan preferensi (TERKUNCI arah)

Keputusan: hitung COGS per appointment per channel sebelum kunci. Baseline dari riset: WhatsApp utility orde sen per pesan, SMS $0,01-0,05, voice $0,40-0,70 per reschedule call 3-5 menit. Strategi: WhatsApp/SMS-first, voice hanya eskalasi. BYOA (assistant milik sendiri di atas WhatsApp API) vs Meta Business Agent (~4-5 sen/pesan token): mulai dengan stack sendiri agar tidak terkunci pricing + eligibility Meta.
SoT: `01-Strategy/05-Product-Vision-and-Solution-Design.md`, `02-Product/03-Multi-Channel-Strategy.md`.

## D-03: MVP didefinisikan dari job, bukan dari agent count (TERKUNCI)

MVP = 1 nomor agent: confirm/cancel/reschedule teks bebas + slot-hold berwaktu + konfirmasi eksplisit + tulis Google Calendar + handoff operator + dasbor slot recovered. Multi-agent build (backend, frontend, audit, security) mempercepat kode, bukan mempercepat integrasi/testing — timeline realistis 3-5 minggu ke pilot-ready, bukan hari.
File: `05-Execution/02-MVP-Scope.md` (diisi setelah deep research pilot kembali).

## D-04: Konektor dikemas sebagai MCP (TERKUNCI arah)

Keputusan: Google Calendar wajib di MVP; konektor PMS berikutnya dibangun sebagai MCP server (satu server per sistem) agar agent tinggal panggil tool. Inventarisasi target konektor di `03-Technical/04-Integrations.md`.
Status: daftar PMS prioritas OPEN sampai beachhead dikunci.

## D-05: Handoff dari first-principles, bukan daftar kasus (TERKUNCI prinsip)

Prinsip: manusia memutus bila aksi (1) irreversible (cancel, charge, kirim ke orang salah), (2) mengandung liability (medis/finansial/darurat), (3) menggerakkan uang, (4) identitas penelepon tak terverifikasi, (5) ambiguitas di bawah threshold confidence, (6) keputusan bisnis/diskresi (diskon, prioritas, pengecualian). Agent sebagai orkestrator: kumpulkan konteks → usulkan opsi → eksekusi setelah approval. Otonom penuh hanya untuk reversible + low-stakes (cek slot, hold, draft, reminder).
Audit penuh di `02-Product/04-Conversation-Flows.md` (berikutnya).

## D-06: Kriteria sukses pilot dari deep research (OPEN)

Deep research metrik pilot dijalankan 22 Sep 2026 (background). Kunci setelah handoff kembali: definisi recovered revenue, sample size, durasi.

## D-07: Framework runtime = LangGraph TypeScript (TERKUNCI)

Harness build tetap OpenCode. Runtime produk LangGraph (stateful loop + checkpointing + `interrupt()` untuk handoff D-05). Scaffold di `product/` (graph, guardrails, CalendarPort, InMemoryCalendar, vitest). GCal adaptor + WhatsApp connector menyusul setelah `npm install` hijau.
