# 01 — Core Features and Scope

> Sumber: subagent deep-research fitur (Firecrawl + developer/paper index, Sep 2026; 3x 429 diatasi backoff). Tanpa invent: efektivitas berangka hanya untuk reminder sequence (RCT); sisanya adopsi industri.

## Must (MVP)

| Fitur | Bukti | SoT |
|---|---|---|
| Conversational book/reschedule/cancel + guardrail per-aksi (allow vs ask-before-action, pola Jobber) | Dipakai semua kompetitor (Vera, Jobber Receptionist) | https://support.vagaro.com/hc/en-us/articles/31806231306779-Set-Up-A-Chatbot-for-Your-Business-with-Vera-Receptionist · https://help.getjobber.com/en/articles/receptionistpowered-by-jobber-ai/ |
| Reminder sequence | RCT pediatri: 23,5% vs 38,1% kontrol (14,6pp, p=0,04); cost-framed SMS DNA 8,4% vs 11,1% | https://www.ncbi.nlm.nih.gov/pmc/articles/PMC5227159/ · https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4569397/ |
| Slot-hold ber-TTL + single-writer endpoint + unique constraint `(provider_id, start_time)` + idempotency key | Konsensus 3 lapis: hold lease (UCP proposal, Medplum `$hold`), re-validasi saat write (Nylas: 1 sukses + 1 error simultan), DB constraint + idempotency (opini praktisi) | https://github.com/universal-commerce-protocol/ucp/issues/317 · https://developer.nylas.com/docs/v3/sdks/node.md · https://github.com/medplum/medplum/blob/2fe66c947fc16ce5b5a11f01cafbf9a0c74c8850/packages/docs/blog/2026-06-01-may-2026-update.mdx |
| Explicit confirmation sebelum write | Adopsi industri; TANPA angka efektivitas publish — jangan tulis angka di PRD | (catatan handoff) |
| Human handoff via keyword-escalation + notifikasi real-time (pola Jobber) | Implementasi Jobber; tanpa angka publish | https://help.getjobber.com/en/articles/receptionistpowered-by-jobber-ai/ |
| Link-fallback bila channel tak dukung booking penuh (pola Vera SMS: kirim link, bukan gagal) | Vera tidak bisa lihat/reschedule via SMS — pola industri diterima | https://support.vagaro.com/hc/en-us/articles/31806231306779-Set-Up-A-Chatbot-for-Your-Business-with-Vera-Receptionist |

## Should (MVP+1)

Waitlist FIFO first-to-reply-wins (pola Fill My Books/DoctorConnect — klaim vendor "hitungan menit", 5 cancel/hari ≈ 75-100 mnt staf; TANPA angka independen); cancel 1-tap; dashboard log tiap conversation (pola Jobber).

## Could / Won't

- Could: auto-promo slot kosong, outreach referencing last service.
- Won't now: no-show prediction scoring, dynamic discounting, multi-location sync chatbot, voice calls (tier atas/enterprise atau per-minute di semua kompetitor).

## In / Out scope

- In: WhatsApp/SMS primary; online-booking-backed schedule sebagai source of truth (syarat reschedule ala Jobber).
- Out: voice infra per-minute (ekonomi Bland $0,11-0,14/mnt tak cocok flat-rate SMB); SMS in-call nodes enterprise; full autonomous booking tanpa konfirmasi eksplisit.

## Pricing anchor untuk scope (fakta publik Sep 2026, dapat berubah)

- Vagaro Vera add-on per lokasi: $10 (1) / $20 (2-5) / $30 (6-20) / $50 (21-100) / $160 (101-500) — TAPI blog sebut included: konflik internal, asumsikan add-on/upsell. https://www.vagaro.com/pro/business-ai
- Jobber Receptionist: Plus unlimited included; add-on plan tertentu $29 (30 convos, overage $0,79) — pakai dok help center terbaru (Academy sebut $99/$449, konflik dilaporkan). https://help.getjobber.com/en/articles/receptionistpowered-by-jobber-ai/
- Bland: $0,14/mnt Start; $0,12 + $299 Build; scheduling node + SMS/webchat hanya kolom Enterprise — untuk kita scheduling justru core (diferensiasi). https://www.bland.ai/pricing
- Avoca $1.000-3.500/bln = estimasi pihak ketiga (serviceagent.ai), BUKAN resmi — jangan kutip sebagai fakta; validasi celah sub-$100/bln SMB.

## Keputusan owner (bukan blocker riset)

Model harga MVP: flat add-on ala Jobber ($29/30 convos) vs bundled ala Vagaro — menentukan batas overage & guardrail usage.
