# 03 — Pricing and Packaging

> Context: `docs/01-Strategy/06-Business-Model-and-Pricing.md` (USD benchmarks) + Indonesia observations from this session. Labels: [Fact — official], [Fact — vendor], [Fact — independent/secondary], [Interpretation]. Every number carries its source URL. Conflicts shown as-is; do not resolve by averaging.

## 1. Cost floor facts (what the builder must model)

- Meta bills per delivered template message; rates vary by category × recipient country code — [Fact — official] https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing.
- Since 1 Jul 2025 Meta bills per-message; non-template messages inside an open 24h customer-service window are not charged; utility templates in response inside the window are not charged; 72h free-entry-point window after Click-to-WhatsApp ads is free — [Fact — official] https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing.
- Change coming 1 Oct 2026: utility inside the window and service messages become chargeable (1,000 free service msgs/number/month noted in product research) — [Fact — official docs change notice] https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing ; also summarized in `docs/01-Strategy/05-Product-Vision-and-Solution-Design.md` §5.2. Re-verify on the official page at contracting time — the date has likely passed relative to build.
- Indonesia card (secondary, MUST re-check Meta rate card before quoting): Marketing Rp586.33/msg, Utility Rp356.65/msg, Authentication Rp356.65/msg, +11% VAT; utility/auth volume discounts −5% to −25% by tier; marketing not tiered; ChatMaxima flat $19/mo no-markup positioning — [Fact — secondary, vendor-positioned] https://chatmaxima.com/whatsapp-api-pricing/indonesia/.
- Worked implication (arithmetic on the secondary card, NOT a quote): 1,000 marketing msgs ≈ Rp586,330 + VAT ≈ Rp650,826 — [Derived from] https://chatmaxima.com/whatsapp-api-pricing/indonesia/. A 3-reminder sequence (T-48h/T-24h/T-2h) that stays UTILITY-pure costs a fraction of a marketing mix; one promo sentence reclassifies to MARKETING — [Fact — official categorization] https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-categorization (via `05-Product-Vision` §5.2). Keep reminders promo-free — [Interpretation].

## 2. Willingness-to-pay facts (conflicting — read both columns)

| Source | Number | Label + URL |
|---|---|---|
| KlinikPintar clinic SaaS, "Siap ... Rp300ribu/bulan" | Rp300rb/mo per clinic package | [Fact — vendor] https://klinikpintar.id/aplikasiklinik/faskes/klinik-kecantikan |
| ICONIX beauty clinic | Rp475rb / 575rb / 675rb/mo tiers | [Fact — vendor] https://www.iconix.id/hcantik.html?srsltid=AU7gw4XPNHH4TKv5JrcBnndliyN-0DwuFewAJK2skxKKMRZdP0LRYXoI |
| MyKlinik social claim | Rp250rb/mo "all in"; promo Rp100rb/doctor/mo | [Fact — vendor social, weak] https://www.instagram.com/reel/C-o_tzlvtjH/ ; https://www.instagram.com/p/DSE1wMokeTP/ |
| Salon/smb POS roundups | Moka Rp299rb/499rb/799rb; Majoo from Rp249rb; Majoo Rp199–499rb, Olsera Rp149–599rb; salon comps Rp99–299rb | [Fact — secondary] https://www.equiperp.com/blog/aplikasi-moka-pos-dan-alternatifnya/ ; https://founderplus.id/blog/aplikasi-kasir-pos-ukm-terbaik/ ; https://klikit.io/id/learn/moka-vs-majoo-vs-olsera-indonesia ; https://www.kasera.id/perbandingan/aplikasi-kasir-salon-terbaik |
| US dental comms (transferability LIMITED) | Weave from $199/mo/location; Solutionreach $199–349; NexHealth est ~$350 | [Fact — vendor official pages via `04-Competitive-Landscape.md`] (see that file for page URLs) |
| AI-voice cost anchors (US) | Bland $0.14/min Start, $0.12 + $299/mo Build; Goodcall $79–249/mo/agent; Smith.ai AI $0–500 + per-call | [Fact — vendor] https://www.bland.ai/pricing ; https://www.goodcall.com/pricing ; https://smith.ai/pricing/ai-receptionist (via `06-Business-Model-and-Pricing.md`) |
| Prior internal hypothesis | Starter Rp1.5–2.5jt (SEA) or $199–349 (US); Growth Rp3.5–5jt | [Interpretation/Assumption — `enterprise/07` §7.3], CONFLICTS with observed Rp100–675rb local anchors above |

Conflict statement: observed Indonesian clinic/salon software transacts at roughly Rp100–800rb/outlet/mo; the internal Rp1.5–5jt hypothesis is 2–10× higher with no Indonesia observation behind it. Do not freeze at the hypothesis. Pilot WTP decides.

## 3. Packaging recommendation (interpretation — smallest safe step)

- Structure (keep from `06-Business-Model-and-Pricing.md` §6.5, re-denominate for beachhead): base per-location + usage pass-through + one outcome add-on AFTER proof. Tiers:
  - **Pilot (30 days):** discounted/flat pilot fee, 1 number, 1 calendar, T-48h/T-24h/T-2h utility-pure reminders + reschedule flow; Meta/WhatsApp fees itemized at cost; exit = paid conversion or offboard.
  - **Starter (per location/mo):** 1 number + 1 calendar + reminders + basic reschedule + human handoff; message/voice overage at cost + disclosed margin; no annual lock-in for the first 20 customers (avoids the $750-setup / annual-lock complaint pattern noted for Weave/Solutionreach in `04-Competitive-Landscape.md`).
  - **Growth (hero tier, per location/mo):** + waitlist backfill + recall + multi-calendar + PMS write-back + digest/analytics; onboarding fee waivable on annual.
  - **Multi-location (custom):** volume discount, SLA, audit log, BAA-equivalent/PDP commitments.
- Do NOT sell pure outcome-based pricing at launch ("$ per kept appointment") — [Interpretation] from `06-Business-Model-and-Pricing.md` §6.5 and `enterprise/08` §8.1: outcome fees only after accuracy/recovery is measured (suggested pilot instrument: $15–25 per booked-kept with 30-day dedup, no-show unbilled — pilot instrument only, not list price).
- Price numbers are deliberately NOT frozen in this doc: set the IDR figure after 5 pilots log (a) messages kept-utility vs slipped-marketing, (b) minutes/voice fallback COGS, (c) recovered slots × clinic price-list value, (d) stated WTP vs current PMS/POS spend. `enterprise/07` §7.6 gate (5 pilots → case study → price freeze) stands.

## 4. Guardrails

- Template purity: any promo inside a reminder reclassifies it to marketing rate + quality-rating risk — [Fact — official] via `05-Product-Vision` §5.2. Enforce "utility-murni" lint before send.
- VAT: +11% PPN on Meta + platform fee in Indonesia — [Fact — secondary] https://chatmaxima.com/whatsapp-api-pricing/indonesia/. Quote VAT-inclusive to clinics.
- 1-Oct-2026 change: re-read https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing before any annual quote; free-window assumptions from 2025 do not carry forward.
- Sources: inline URLs only. Vendor vs secondary vs interpretation labeled. No invented citations.
