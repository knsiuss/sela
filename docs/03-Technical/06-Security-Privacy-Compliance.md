# 06 — Security, Privacy and Compliance

> BUKAN nasihat hukum — validasi ke counsel. Fakta dari DLA Piper (update 13 Feb 2026) + HHS primer.

## PDP Indonesia (UU 27/2022)

| Fakta | SoT |
|---|---|
| Diundangkan 17 Okt 2022; transisi 2 thn s.d. 17 Okt 2024; kini full compliance dapat ditegakkan; dimodelkan GDPR | https://www.dlapiperdataprotection.com/?t=law&c=ID |
| Data sensitif: health, biometrik, genetik, kriminal, anak, finansial | sama |
| DPO wajib hanya: layanan publik / monitoring sistematis skala besar / inti = proses data sensitif skala besar | sama |
| Controller wajib ROPA; prinsip: terbatas/spesifik, sesuai tujuan, hak subjek (akses, koreksi, hapus, tarik consent, keberatan, batasi, portabilitas), akurat, aman, notifikasi tujuan + kegagalan, hapus kecuali retensi hukum, akuntabel | sama |
| Breach: notifikasi tertulis ≤72 jam ke subjek + PDP Agency; ke publik bila ganggu layanan/kepentingan signifikan; isi: data apa, kapan/cara, mitigasi | sama |
| Sanksi admin: teguran, suspensi, hapus, denda s.d. 2% pendapatan tahunan; pidana: ambil/ungkap/gunakan/palsukan (individu 4-6 thn / IDR200-500jt, korporasi s.d. 10x) | sama |
| PDP Agency belum beroperasi; RPP + Perpres masih harmonisasi (target 2026); sementara KOMDIGI otoritas utama + regulator sektoral | sama |
| Transfer lintas negara: adequasi, atau safeguard mengikat, atau consent (penilaian oleh Agency, belum ada daftar) | sama |
| PSE Indonesia: registrasi TDPSE + self-assessment, audit record, hapus lewat retensi/atas permintaan, sediakan kontak | sama |

Implikasi builder: dasar hukum eksplisit (consent/kontrak); ROPA hari-1; retensi + hapus otomatis; alur hak subjek + export/hapus saat churn; consent opt-in WA terpisah dari data klinis.

## HIPAA (hanya wajib bila sentuh PHI AS)

HHS primer: safeguards administratif + fisik + teknis yang reasonable & appropriate (skalabel, tech-neutral); Access Control, Audit Controls, integrity, authentication, transmission security; risk analysis/management, minimum necessary, training, incident procedures, contingency (backup/restore/emergency mode); BAA tertulis SEBELUM BA sentuh ePHI; dokumentasi 6 tahun. https://www.hhs.gov/hipaa/for-professionals/security/laws-regulations/index.html
Pasar murni Indonesia: JANGAN klaim "HIPAA compliant" — pakai sebagai baseline (RBAC, least privilege, audit log, TLS + AES-256, backup teruji, risk review). Enkripsi perlakukan wajib (breach safe harbor). Supabase: AES-256 rest + TLS; PITR add-on; checklist HIPAA formal verifikasi di dashboard. https://supabase.com/security

## PII chat

Minimisasi (hash nomor, redaksi gejala dari log), retensi pendek mentah (30-90 hari — KEPUTUSAN builder OPEN), hapus/export saat churn. Jangan log token/password/nomor penuh.

## Keputusan builder OPEN

(1) Simpan PHI AS? (BAA formal vs baseline). (2) Retensi PII mentah + kebijakan export/hapus churn.

## Threat model STRIDE-lite (subagent, Sep 2026)

| Threat | Boundary | Mitigasi |
|---|---|---|
| Spoofing webhook (POST palsu / verify bypass) | Internet → endpoint | HMAC-SHA256 body vs `X-Hub-Signature-256` + constant-time compare; `hub.verify_token` constant-time; TLS publik (self-signed ditolak); mTLS opsional; tolak tanpa signature. https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint/ |
| Tampering booking / cross-tenant write / replay | Webhook/LLM-tool → Postgres + GCal | Idempotency `wamid` + unique constraint; tenant scoping semua query; validasi slot server-side; jangan percaya `from`/nama payload untuk otorisasi |
| Repudiation (sengketa siapa minta apa) | Agent → DB/log | Simpan raw event + `wamid`, `phone_number_id`, timestamp, `request_id`, hasil, actor; audit append-only (Meta tak sediakan API historis; retry s.d. 7 hari) |
| Info disclosure PII chat via log/DB/backup | Chat store → log/DB/dump | Minimisasi kolom; redaction saat ingestion (Pino paths + `remove`), bukan display; jangan log raw body/headers/token; Supabase Vault AEAD + lindungi view via privilege. https://supabase.com/docs/guides/database/vault · https://www.dash0.com/guides/logging-in-node-js-with-pino |
| DoS retry storm / batch 1000 / duplikat | Meta → Node → DB/Calendar | 200 cepat + enqueue async; dedup; rate-limit per `wa_id`/IP; limit body + timeout; circuit-breaker (angka limit Meta tak terverifikasi — jangan jadi syarat) |
| Elevation via prompt injection (jailbreak → bocor token / booking tenant lain) | Chat → LLM → tools | Structured prompt (SYSTEM vs USER_DATA); tool allowlist + validasi param vs session tenant; system prompt tanpa secret; output filter; HITL untuk mutasi booking. https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html · https://genai.owasp.org/llmrisk/llm01-prompt-injection/ |

Secrets & OAuth: app secret + verify token di secret manager, rotasi terjadwal/saat compromise; refresh token per-tenant encrypted (Vault/AEAD), akses service_role server-only, scope minimal + incremental; tangani refresh invalid/limit 100/test-mode 7 hari. https://developers.google.com/identity/protocols/oauth2
Gate launch: middleware verify + token encrypted + redaction log + LLM least-privilege. Tanpa ini jangan launch.
