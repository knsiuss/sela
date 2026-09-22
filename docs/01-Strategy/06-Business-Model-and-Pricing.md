# 06 — Business Model and Pricing

> Sumber: subagent deep-research pricing (Firecrawl scrape, Sep 2026). Harga USD, dapat berubah. Label [Fakta]/[Interpretasi] wajib.

## 6.1 Fakta pricing kompetitor (scrape langsung)

| Kompetitor | Harga dasar | Usage / overage | Setup / catatan | SoT |
|---|---|---|---|---|
| Goodcall | Starter $79/mo per agent ($66 annual); Growth $129 ($108); Scale $249 ($208); Enterprise custom | Unlimited minutes+tokens; allowance 100/250/500 unique customers; overage $0,50/customer | 1 agent per location; >10 agents ke sales | https://www.goodcall.com/pricing |
| Smith.ai human-first | Starter 30 calls $300; Basic 90 calls $810; Pro 300 calls $2.100; Enterprise custom | Overage $11,50 / $10,50 / $8,50 per call; add-on booking +$1,50/call, SMS +$0,50, recording +$0,25 | No setup fee, month-to-month, spam tidak dihitung | https://www.smith.ai/pricing |
| Smith.ai AI-first | Free $0 (25 calls incl, $3,00 extra); Pro $150 ($2,00/call, 75 incl); Enterprise $500 ($1,67/call, 300 incl) | Extra-call $2,50/$2,17; tier 150 (-10%), 300 (-17%) | Human-backup upsell; 10% spam allowance; 30 hari notice | https://smith.ai/pricing/ai-receptionist |
| Synthflow | Enterprise mulai $30.000/tahun; SMB self-serve tidak tampil | By volume, concurrency, telephony, integrasi, security | Sinyal naik ke enterprise | https://synthflow.ai/pricing |
| Bland | Start $0,14/min ($0 platform); Build $0,12/min + $299/mo; Enterprise custom | Transfer $0,05/min (Start) / $0,04 (Build); cap 100 vs 2.000 calls/hari; concurrent 10 vs 50 | Termasuk LLM+STT+TTS; telephony pass-through terpisah | https://www.bland.ai/pricing |
| byVoice synthesis (Jul 2026) | Budget $25-49; Mid $60-150; Premium $150-300+/mo | Overage $0,10-0,50/min; per-call ~$2 AI / $7-10+ hybrid | Setup $250-5.000; integrasi $50-500/mo; HIPAA +$50-150/mo | https://www.byvoice.io/blog/ai-receptionist-cost |
| Aloware outcome-based | Qualified lead $3-25; Booked appt $8-40; Tier-1 resolved $1-6; Payment 2-8%; Warm transfer $4-15 | Per-minute loaded $0,07-0,19 (contoh $0,115) | Monthly outcome floor; no seat/setup; pilot 2-4 minggu per-minute lalu kunci harga | https://aloware.com/ai-voice-agent/outcome-based-pricing |

## 6.2 Fakta via search (verifikasi ke pricing page resmi sebelum kontrak)

- Retell AI $0,07-0,31/min pay-as-you-go (base voice $0,07-0,08 + LLM $0,006-0,06 + telephony ~$0,015). https://www.retellai.com/pricing
- Podium Core $399 / Pro $599 + seats ~$30/user + setup $500/location (roundup, resmi quote-only). https://www.pluspoint.io/blog/podium-vs-birdeye-vs-pluspoint-the-ultimate-platform-comparison
- Birdeye Starter $299, Growth $349-399, Dominate $449/location/mo annual (roundup, resmi quote-only). Sama.
- Twilio floor: outbound lokal $0,0140/min, inbound $0,0085/min; SMS ~$0,0083/segmen + carrier. https://www.twilio.com/en-us/voice/pricing/us

## 6.3 Benchmark SMB SaaS umum [BUKAN vertikal — jangan jadi target]

- CAC payback median 16 bulan (2025, n=342); top quartile ≤6; SMB 8-12, mid 14-18, enterprise 18-24. https://www.getaleph.com/answers/cac-payback-period-saas-2026
- NRR median private ~101%; SMB <$25k ACV ~97%. https://www.digitalapplied.com/blog/net-revenue-retention-benchmarks-2026-saas-expansion-data
- Churn SMB 3-5%/bulan logo (N=939); <$10k ACV ~4,1%/bulan. https://optif.ai/learn/questions/b2b-saas-churn-rate-benchmark/
- LTV:CAC median 3,2:1; SMB $5-20k ACV ~2,5:1.

## 6.4 ROI calculators (klaim vendor, ilustrasi saja)

- Formula: Missed Calls x Conversion x Avg Value. MyBCAT: miss dental 25%, optometry 29%, vet 30%; 87% voicemail tidak callback. https://mybcat.com/resources/roi-calculator/
- Peerlogic/Dentina (4.280 calls/26 praktik): 38% tak terjawab; first-visit $250-350; LTV $10k/8-10 thn; 800 calls/bulan → ~$151k/tahun hilang. https://dentina.ai/articles/revenue-lost-missed-calls-dental-practice/
- OmniMD: asumsi 70% recovery, $150-300/appt, $500/provider/mo; klaim ROI 3-8x, payback 1-3 bulan. https://omnimd.com/ai-front-desk-roi-calculator/
- Arini: Wolfe Dental 500 missed/bulan → $134k (2 lokasi); Snow Ortho $42k/bulan LTV; Pearl Street $342k/10 bulan. https://www.arini.ai/roi-calculator

## 6.5 Rekomendasi packaging (interpretasi subagent)

- Starter $149/mo (1 number, ~200 min atau 100 unique customers, 1 calendar, SMS reminders; overage $0,15/min atau $0,50/customer).
- Growth $349/mo hero (~600 min/300 customers, 2 calendars/numbers, CRM sync, recording; onboarding $500-750 gratis jika annual).
- Enterprise/multi-location custom (volume discount, HIPAA/BAA +$99, SLA, multi-sync).
- JANGAN jual outcome murni saat launch; add-on pilot: $15-25 per booked-kept (verified show, dedup 30 hari, no-show tidak ditagih) setelah 2-4 minggu pilot per-minute.
- Validasi pilot: avg handle time, miss baseline, booking conversion, no-show, COGS/min aktual, willingness-to-pay vs recovered revenue.

## Batasan

Benchmark churn/CAC/NRR umum B2B, bukan vertikal. ROI vendor pakai asumsi recovery agresif (50-70%). Tidak validasi kualitas suara/latency, compliance penuh, carrier Indonesia.
