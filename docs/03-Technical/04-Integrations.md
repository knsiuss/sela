# 04 — Integrations

> Sumber: subagent deep-research integrasi (official docs via webfetch + 1 batch Firecrawl; 429 untuk sisanya). GATED = belum terverifikasi, jangan commit.

## A. WhatsApp Cloud API [Fakta, dokumen resmi]

- Setup: Meta App + WABA + phone_number_id + token + webhook `whatsapp_business_account`/`messages`.
- Template: max 100/WABA/jam; nama lowercase+underscore ≤512 char; kategori WAJIB marketing|utility|authentication; status APPROVED sebelum kirim; parameter named|positional.
- Pricing: per-message sejak 1 Jul 2025; hanya `type:template` delivered ditagih; tarif = kategori × calling-code × volume-tier; reset bulanan; IDR rate card ada (nilai tidak diekstrak — baca live).
- Webhook sediakan sinyal billing: `pricing:{billable, pricing_model, type, category}` + update tier/kualitas template/nomor.
- BSP (Qiscus/Wati/dll) + markup: TIDAK terobservasi — anggap pass-through tarif Meta + platform fee sampai cek dokumen BSP.

SoT: https://developers.facebook.com/docs/whatsapp/pricing · https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview · https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started · https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview

## B. Google Calendar API [Fakta]

- `freebusy.query` (POST freeBusy, scope freebusy→calendar; batas 50/100 kalender).
- Events insert/patch/update/delete/list/watch/move/import — full write.
- Push `watch` (web_hook HTTPS, UUID ≤64): header `X-Goog-*`, body kosong (re-fetch wajib), expire tanpa auto-renew, tidak 100% reliable.
- Kuota (update 1 Mei 2026): 10.000 req/mnt/proyek; 600/mnt/user/proyek; 1 jt/hari/proyek (no increase); 403/429 saat exceed; service-account = 1 user kecuali `quotaUser` diset.
- Multi-tenant: OAuth per-tenant + refresh token = path default; service-account + domain-wide-delegation HANYA untuk Workspace yang kita admin, BUKAN Gmail arbitrer [inferensi grounded, konfirmasi saat implementasi].

SoT: https://developers.google.com/workspace/calendar/api/guides/quota · https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query · https://developers.google.com/workspace/calendar/api/guides/push · https://developers.google.com/workspace/calendar/api/guides/auth

## C. Outlook/Graph [Fakta parsial]

`getSchedule` (schedules/start/end/interval) + least-privilege `Calendars.ReadBasic`; events CRUD + subscriptions sejajar Google tapi belum di-fetch — follow-up.

SoT: https://learn.microsoft.com/en-us/graph/api/calendar-getschedule?view=graph-rest-1.0

## D. PMS/FSM matrix

| Sistem | Public API | Write | Status |
|---|---|---|---|
| Open Dental | YA (REST spec + Appointments resource) | YA: POST create/Planned, PUT update/Break/Confirm, GET Slots/ASAP | BUILDABLE — vertikal dental pertama |
| Dentrix / Mangomint / Boulevard / Jobber / Housecall Pro | fetch docs gagal | Unknown | GATED — jangan commit; asumsikan credential vault per-tenant + review partner sampai terverifikasi |

SoT: https://www.opendental.com/site/apispecification.html · https://www.opendental.com/site/apiappointments.html

## E. MCP per konektor [Fakta, spec 2025-06-18]

2 transport standar: stdio (local dev, kredensial dari env) dan Streamable HTTP (remote multi-tenant, session/version headers, OAuth 2.1). 1 server per konektor (whatsapp, google-calendar, outlook, opendental); HTTP untuk remote, stdio lokal; version pin per tanggal spec.

SoT: https://modelcontextprotocol.io/specification/2025-06-18/architecture · https://modelcontextprotocol.io/specification/2025-06-18/basic/transports · https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization

## Build order

1. Google Calendar (freebusy + events + watch, OAuth per-tenant, quotaUser, backoff) → 2. WhatsApp Cloud API direct (utility-first, webhook receiver, pricing-tag logging, idempotent send) → 3. Outlook parity abstraction → 4. Open Dental (Slots→POST→PUT Confirm/Break) → 5. Bungkus tiap konektor jadi MCP HTTP (stdio lokal).
Kontrak internal: `AvailabilityPort{freebusy}` + `BookingPort{create/update/cancel}` + `NotifyPort{template send}` + credential store per-tenant. Log pricing Meta + quota error dari hari pertama. DEFER: BSP lock-in + PMS GATED.

## F. CRM (ditambahkan 23 Sep 2026)

CRM = konektor baru di pola yang sama (1 MCP server per sistem), bukan redesign. Prioritas setelah adapter PMS pertama terbukti — CRM lebih mudah (tulis kontak/timeline/deal, tanpa risiko double-book).

| CRM | Status | Catatan |
|---|---|---|
| HubSpot | Kandidat pertama — API publik + OAuth matang, timeline sync standar | Banyak dipakai SMB target |
| Salesforce | Setelah HubSpot — API lengkap tapi auth/scope enterprise berat | — |
| Pipedrive / Zoho / Freshsales | Antrean — REST + API key/OAuth | — |
| Spreadsheet / Airtable | Wedge pilot non-teknis tercepat | Opsional |

Payload ke CRM per recovered booking: contact + deal + timeline event + sumber channel (WA/SMS) + nilai. Dasbor recovered revenue boleh baca dari sini juga. Jangan commit vendor spesifik sampai docs write terverifikasi (aturan GATED yang sama).
