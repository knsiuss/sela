# 09 — Risk Analysis

| Risiko | Bukti | Mitigasi |
|---|---|---|
| Double-book / wrong booking | Failure termahal; LLM tanpa lock | Single writer + hold + konfirmasi eksplisit; human oversight awal |
| Hallucination slot | Aturan durasi/buffer/resource kompleks | Guardrail + source-of-truth tunggal; threshold eskalasi |
| Meta policy change | Agent harus task-specific | Patuh template/opt-in; multi-channel fallback SMS |
| Kompetitor Meta membaik | Meta Business Agent native WhatsApp | Menang di vertical depth + PMS write-back + bahasa lokal |
| Integrasi PMS lokal minim API | Banyak software lokal tanpa API | Pilih PMS dengan API dulu; jangan janji semua |
| Trust/adoption | Owner ragu serahkan booking | Pilot + case study angka; handoff jelas |
| Voice cost/latensi | $0.25/mnt; stack 5-vendor gagal saat burst | SMS/WhatsApp dulu; voice setelah unit economics jelas |
| Churn SMB | Sensitif harga, butuh ROI 30 hari | Pricing transparan; dashboard recovered revenue |
| Regulasi kesehatan/PDP | BAA/SSO/VPC; UU PDP | Mulai non-HIPAA; tier enterprise untuk klinik |

Risk matrix: prioritas P1 = double-book, integrasi, churn 30 hari. P2 = Meta policy, voice cost. P3 = scale multi-location.
