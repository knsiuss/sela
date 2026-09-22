# Praktik dokumentasi FAANG (hasil riset)

> Sumber: Industrial Empathy (Google design docs), Pragmatic Engineer (RFC), runbook/postmortem guides. Sep 2026.

## 1. Design doc ala Google (anatomi baku)

Context & scope (fakta objektif, ringkas) → Goals & non-goals (non-goals = hal yang wajar jadi goal tapi eksplisit bukan) → Actual design (overview dulu, fokus TRADE-OFF) → system-context diagram → APIs (sketsa relevan, jangan copy definisi lengkap) → data storage (bentuk kasar, bukan full schema) → code/pseudocode (JARANG, hanya algoritma novel) → degree of constraint → alternatives considered → cross-cutting concerns.
Fungsi: temukan isu saat murah, konsensus, cross-cutting, scale pengetahuan senior, memori organisasi.
SoT: https://www.industrialempathy.com/posts/design-docs-at-google/ · https://blog.pragmaticengineer.com/rfcs-and-design-docs/

## 2. RFC lintas perusahaan

Uber: approvers + struktur per service. Aturan umum: tulis sebelum koding non-trivial, minta review seperti code review. PRD produk jalan berdampingan dengan design doc teknik.
SoT: sama di atas.

## 3. Yang Meta TIDAK lakukan (pelajaran negatif)

Meta/Facebook paling minim dokumentasi di Big Tech — bekerja karena tenure panjang + engineer top + sistem penyeimbang. Jangan ditiru tim kecil/remote/async.

## 4. Runbook (prosedur operasi)

Jenis: incident response, change, deployment, disaster recovery, maintenance, onboarding/offboarding, monitoring. Syarat hidup: owner jelas, langkah rollback setara detailnya, langkah validasi tiap tahap, ringkas (tanpa background arsitektur), direview berkala, bisa diakses saat outage (di luar SSO yang mati), diuji non-penulis.
SoT: https://checkflow.io/blog/it-runbook-template · https://www.itoc360.com/what-is-a-runbook/

## 5. Postmortem & retrospektif

Postmortem: timeline insiden, faktor kontribusi, dampak, pelajaran, follow-up. Retrospektif: apa jalan/tidak + aksi. Manual ~75-105 mnt/insiden; otomatisasi bisa tekan (klaim vendor).
SoT: https://incident.io/blog/best-postmortem-software-platform-for-engineering-teams-2026 · https://contextstream.io/docs/platform/documents

## Mapping ke repo kita

| FAANG | Kita |
|---|---|
| Design doc | `docs/adr/*` + `03-Technical/architecture.md` (tambah Goals/non-goals + alternatives per ADR) |
| PRD | `02-Product/*` |
| Runbook | BELUM ADA → buat `docs/06-Appendix/J-Runbooks.md` (deploy, rollback, restore, webhook down) |
| Postmortem | BELUM ADA → template `docs/05-Execution/07-Postmortems.md` saat insiden pertama |
| RFC process | Decision-Log + review ADR sebelum build |
