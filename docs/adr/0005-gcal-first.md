# ADR 0005 — Integrasi pertama: GCal, PMS kedua: Open Dental

Status: Accepted (23 Sep 2026)
Context: butuh write-back terpercaya minggu-1; 5 PMS lain GATED. Alternatif: langsung PMS vertikal.
Decision: Google Calendar dulu (freebusy + events + watch, OAuth per-tenant); Open Dental sebagai bukti vertikal pertama (REST write terbukti); Dentrix/Mangomint/Boulevard/Jobber/HCP defer sampai docs write terverifikasi. Bukti: `docs/03-Technical/04-Integrations.md`.
Consequences: Plus: jalan minggu-1 tanpa akses partner. Minus: aturan vertikal dangkal sampai adapter PMS lahir (mitigasi: aturan di config per tenant).
