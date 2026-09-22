# 01 — Beachhead Market

> Source context: `docs/01-Strategy/04-Competitive-Landscape.md`, `docs/01-Strategy/06-Business-Model-and-Pricing.md`, `docs/enterprise/07-Go-to-Market-Strategy.md`. Labels: [Fact — vendor], [Fact — official], [Fact — independent/secondary], [Interpretation], [Assumption]. Every number carries its source URL. Conflicting data is shown as-is.

## 1. Decision criteria (builder gate)

Pick exactly one beachhead. A segment qualifies only if all five hold:

1. Reschedule volume: 20+ manual reschedules/week per location (threshold from `docs/enterprise/07-Go-to-Market-Strategy.md` — [Assumption], not externally sourced; must validate in pilot intake).
2. WhatsApp-native demand: booking/confirmation already happens over WhatsApp (channel fit per `docs/01-Strategy/05-Product-Vision-and-Solution-Design.md`).
3. One writable calendar/PMS: at least one PMS with a write-back-capable API so rebook writes back idempotently (moat per `docs/01-Strategy/04-Competitive-Landscape.md` — [Interpretation]).
4. Reachable cluster: 20–50 prospectable outlets in one metro via one channel (one association chapter, one PMS reseller, or one BSP cohort) — [Assumption].
5. ARPU realism: segment already pays for software per outlet per month (anchor below), so a reschedule agent is an upsell, not first software sale — [Interpretation].

## 2. Candidate facts (no cherry-picking)

| Candidate | Supporting facts | Conflicting / negative facts |
|---|---|---|
| Boutique dental / beauty (klinik gigi, klinik kecantikan, klinik pratama), Indonesia, WhatsApp-first | KlinikPintar publishes tiered clinic packages including "Siap ... Rp300ribu/bulan" for klinik pratama — [Fact — vendor] https://klinikpintar.id/aplikasiklinik/faskes/klinik-kecantikan. ICONIX publishes beauty-clinic tiers Business Rp475rb, Premium Rp575rb, Enterprise Rp675rb/month — [Fact — vendor] https://www.iconix.id/hcantik.html?srsltid=AU7gw4XPNHH4TKv5JrcBnndliyN-0DwuFewAJK2skxKKMRZdP0LRYXoI. Social vendor claims: MyKlinik "250 ribu/Bulan All In" — [Fact — vendor social, weak, single post] https://www.instagram.com/reel/C-o_tzlvtjH/ ; promo "Rp100.000/Dokter/bulan" — [Fact — vendor social, weak] https://www.instagram.com/p/DSE1wMokeTP/. No-show pain is documented for dental/beauty (dental 12%, beauty/nail 14% planning ranges — [Fact — secondary aggregator] https://www.etisia.com/no-show-statistics; dental 15% US cross-specialty — [Fact — vendor blog with data] https://www.solutionreach.com/blog/which-wins-the-national-average-no-show-rate-or-yours-1). | Local willingness-to-pay anchors (Rp100–675rb/mo) CONFLICT with `enterprise/07` hypothesis "Starter Rp1.5–2.5jt/lokasi" and `01-Strategy/06` "Starter $149/mo" — both [Assumption/Interpretation], not market-observed in Indonesia. Do not price off the higher hypothesis until pilot WTP is measured. Competitive gap note: US dental incumbents charge $199–349/location/mo (Weave/Solutionreach official pricing pages per `04-Competitive-Landscape.md`) — proves dental pays for comms, but does NOT transfer to IDR pricing. |
| Salon/spa general (non-medical), Indonesia | POS/salon SaaS anchors: Moka Basic Rp299.000/outlet/month, Pro Rp499.000, Enterprise Rp799.000 — [Fact — secondary roundup] https://www.equiperp.com/blog/aplikasi-moka-pos-dan-alternatifnya/ ; Majoo from Rp249.000/month, Moka from Rp299.000/month — [Fact — secondary] https://founderplus.id/blog/aplikasi-kasir-pos-ukm-terbaik/ ; Majoo Rp199.000–499.000, Olsera Rp149.000–599.000 ranges — [Fact — secondary] https://klikit.io/id/learn/moka-vs-majoo-vs-olsera-indonesia ; salon-specific "Rp99rb–299rb/outlet/month" comparisons — [Fact — secondary] https://www.kasera.id/perbandingan/aplikasi-kasir-salon-terbaik. US salon proof that per-location flat pricing works (Fresha/Vagaro/Mangomint per `04-Competitive-Landscape.md`). | Salon ARPU anchors are the LOWEST of all candidates (floor ~Rp99–149rb/mo). Reschedule value prop competes with marketplace commission models (Fresha 20% new-client commission per `04-Competitive-Landscape.md`) — different buyer math than clinics. No Indonesia-specific salon no-show/cancel rate found in this research — do not import Etisia 14–15% as local fact. |
| HVAC / home-service, US (SMS+voice) | US willingness-to-pay is highest: Jobber/Housecall tiers $49–399/mo + $29–35/user; ServiceTitan est. $245–500/tech/mo (per `04-Competitive-Landscape.md` with SoTs). After-hours ticket premiums ($450–600 vs $275 day) documented — [Fact — secondary] https://www.hicira.com/missed-call-statistics (cited in `02-Problem-Definition`). | Requires SMS+voice-first stack, US telephony (Twilio floor outbound $0.0140/min, inbound $0.0085/min — [Fact — official] https://www.twilio.com/en-us/voice/pricing/us), and US distribution from Indonesia — highest CAC distance. Directly conflicts with "WhatsApp-first Indonesia" motion (different channel, timezone, compliance). `enterprise/07` framed it as EITHER/OR with dental/fisio — picking both splits focus. |
| Hospital / ARSSI network | ARSSI exists as national private-hospital association with secretariat WhatsApp contact — [Fact — official] https://arssi.id/ ; chapter site — [Fact — official] https://arssipusat.org/. Theory: association = distribution. | Hospitals are enterprise (multi-year contracts, $5k–50k implementation per `04-Competitive-Landscape.md` — [Interpretation] built on third-party estimates). No member-count, procurement-cycle, or SaaS-budget fact found in this research (searched; ARSSI pages publish no pricing or vendor-program terms). Enterprise sale contradicts "20 pilot cepat" motion. Deferred. |

## 3. Recommendation (interpretation, not fact)

**Beachhead: boutique dental / beauty / pratama clinics in one Indonesian metro, WhatsApp-first, attached to exactly one PMS.**

- Why this one: only candidate with (a) documented reschedule pain in analogous settings, (b) local per-outlet SaaS payment habit (Rp300–675rb/mo observed vendor pricing), (c) WhatsApp cost structure the builder can model today (Meta per-message billing — [Fact — official] https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing ; IDR card Marketing Rp586.33, Utility Rp356.65 + 11% VAT — [Fact — secondary, verify on Meta rate card] https://chatmaxima.com/whatsapp-api-pricing/indonesia/), and (d) single-integration depth (one PMS write-back) per moat logic.
- Scope lock: one city, one PMS, 3–5 pilot outlets, 30 days, with baseline-data access as entry condition (per `enterprise/07` §7.2).

## 4. Explicitly deferred (and re-entry condition)

- Salon/spa general: deferred until one clinic case study with recovered-revenue math exists; re-enter only if a salon PMS offers the same write-back depth.
- HVAC/US: deferred until Indonesia motion has CAC payback evidence; re-enter only with a US-based design partner and SMS/voice COGS measured.
- Hospital/ARSSI enterprise: deferred until SMB churn (<3–5%/mo logo benchmark is generic B2B, NOT vertical — [Fact — secondary benchmark] https://optif.ai/learn/questions/b2b-saas-churn-rate-benchmark/) is beaten in SMB; no hospital outreach before that.

## 5. Uncertainty + validation required

- Transferability: all no-show/call-answer rates above are US/EU/UK (2021–2026). Indonesia outlet counts, no-show baselines, and WhatsApp-vs-walk-in mix are UNKNOWN — no BPS/Kemenkes/association census found in this research. Validate via pilot intake logs, not blogs.
- WTP conflict: Rp100–675rb/mo observed vs Rp1.5–2.5jt/mo hypothesized. Validation: ask pilot prospects "what do you pay KlinikPintar/ICONIX/POS today?" before quoting; freeze price only after 5 pilots (per `enterprise/07` §7.6).
- Association reach: ARSSI confirms hospitals have an association channel, but the DENTAL/beauty association equivalent (PDGI chapter? Aesthetic clinic groups?) was NOT verified — search returned only ARSSI hospital results. Validation: one discovery call with a dental/beauty association chapter or PMS reseller before counting it as a channel.
- Sources: see inline URLs. No invented citations. Vendor claims labeled; secondary roundups labeled; interpretations labeled.
