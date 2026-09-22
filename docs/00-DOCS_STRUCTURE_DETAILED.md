# 00 — Docs Structure Detailed

Peta struktur `docs/` + mapping dari dokumen lama agar tidak duplikasi.

## Tree

```text
docs/
├── 00-DOCS_STRUCTURE_DETAILED.md
├── README.md
├── 01-Strategy/
│   ├── 01-Executive-Summary.md
│   ├── 02-Problem-Definition-and-Market-Pain.md
│   ├── 03-Market-Analysis.md
│   ├── 04-Competitive-Landscape.md
│   ├── 05-Product-Vision-and-Solution-Design.md
│   └── 06-Business-Model-and-Pricing.md
├── 02-Product/
│   ├── 01-Core-Features-and-Scope.md
│   ├── 02-User-Personas-and-Journeys.md
│   ├── 03-Multi-Channel-Strategy.md
│   ├── 04-Conversation-Flows.md
│   └── 05-Success-Metrics-and-KPIs.md
├── 03-Technical/
│   ├── 01-System-Architecture.md
│   ├── 02-Recommended-Tech-Stack.md
│   ├── 03-AI-Agent-Framework-Choice.md
│   ├── 04-Integrations.md
│   ├── 05-Data-Model-and-Database.md
│   ├── 06-Security-Privacy-Compliance.md
│   └── 07-Infrastructure-and-Deployment.md
├── 04-Go-to-Market/
│   ├── 01-Beachhead-Market.md
│   ├── 02-Customer-Acquisition-Strategy.md
│   ├── 03-Pricing-and-Packaging.md
│   └── 04-Partnership-Strategy.md
├── 05-Execution/
│   ├── 01-Implementation-Roadmap.md
│   ├── 02-MVP-Scope.md
│   ├── 03-Team-and-Roles.md
│   ├── 04-Progress-Tracking.md
│   ├── 05-Risk-Register.md
│   └── 06-Decision-Log.md
├── 06-Appendix/
│   ├── A-Competitor-Deep-Dives.md
│   ├── B-Feature-Comparison-Matrix.md
│   ├── C-Sample-Conversation-Flows-Detailed.md
│   ├── D-Architecture-Diagrams.md
│   ├── E-Market-Sizing-Calculations.md
│   ├── F-Tech-Evaluation-Notes.md
│   ├── G-Glossary.md
│   └── H-References-and-Sources.md
├── research-notes/
│   ├── ai-agent-frameworks-2026.md
│   ├── firecrawl-self-hosting.md
│   ├── whatsapp-cloud-api.md
│   ├── competitor-notes/
│   └── interview-notes/
├── assets/
│   ├── diagrams/
│   ├── screenshots/
│   ├── wireframes/
│   └── competitive-matrix/
├── research/            # arsip riset terverifikasi (sumber migrasi)
├── enterprise/          # laporan lama 01-11+99 (sumber migrasi)
└── meta/                # kerangka lama
```

## Mapping migrasi (sumber → tujuan baru)

| Sumber lama | Tujuan baru |
|---|---|
| `enterprise/01-Executive-Summary.md` | `01-Strategy/01-Executive-Summary.md` |
| `enterprise/02-Problem-and-Market-Pain.md` | `01-Strategy/02-Problem-Definition-and-Market-Pain.md` |
| `enterprise/03-Market-Analysis.md` | `01-Strategy/03-Market-Analysis.md` + `06-Appendix/E-Market-Sizing-Calculations.md` |
| `enterprise/04-Competitive-Landscape.md` | `01-Strategy/04-Competitive-Landscape.md` + `06-Appendix/A-Competitor-Deep-Dives.md` + `06-Appendix/B-Feature-Comparison-Matrix.md` |
| `enterprise/05-Product-Vision-and-Solution.md` | `01-Strategy/05-Product-Vision-and-Solution-Design.md` + `02-Product/01-Core-Features-and-Scope.md` |
| `enterprise/06-Technical-Architecture.md` | `03-Technical/01-System-Architecture.md` + `03-Technical/02-Recommended-Tech-Stack.md` |
| `enterprise/07-Go-to-Market-Strategy.md` | `04-Go-to-Market/` (semua) |
| `enterprise/08-Business-Model-and-Financials.md` | `01-Strategy/06-Business-Model-and-Pricing.md` |
| `enterprise/09-Risk-Analysis.md` | `05-Execution/05-Risk-Register.md` |
| `enterprise/10-Implementation-Roadmap.md` | `05-Execution/01-Implementation-Roadmap.md` + `05-Execution/02-MVP-Scope.md` |
| `enterprise/11-Conclusion-and-Next-Steps.md` | Dipakai sebagai penutup tiap folder, bukan file sendiri |
| `enterprise/99-Appendix.md` | `06-Appendix/H-References-and-Sources.md` + `06-Appendix/G-Glossary.md` |
| `research/01-kekurangan-kelebihan-ai-agent.md` | `02-Product/05-Success-Metrics-and-KPIs.md` (konteks tradeoff) + `05-Execution/06-Decision-Log.md` |
| `research/02-masalah-utama-dan-data-source.md` | `01-Strategy/02-Problem-Definition-and-Market-Pain.md` |
| `research/03-solusi-existing-dan-kekurangan.md` | `06-Appendix/A-Competitor-Deep-Dives.md` + `06-Appendix/B-Feature-Comparison-Matrix.md` |
| `research/Vertical_*_Deep_Research_2026.md` | `02-Product/04-Conversation-Flows.md` + `02-Product/03-Multi-Channel-Strategy.md` |

## Aturan

1. File baru saat ini skeleton. Migrasi bertahap: copy fakta + source, beri label [Fakta]/[Asumsi]/[Interpretasi].
2. `research-notes/` untuk mentah yang belum terverifikasi live-search. Naik ke `01-06` hanya setelah ada source.
3. `05-Execution/04-Progress-Tracking.md` dan `06-Decision-Log.md` diupdate tiap ada keputusan (contoh: beachhead 1 vertikal + 1 PMS).
4. Setelah migrasi selesai, arsipkan `enterprise/`, `research/`, `meta/` (jangan hapus sebelum diverifikasi).
