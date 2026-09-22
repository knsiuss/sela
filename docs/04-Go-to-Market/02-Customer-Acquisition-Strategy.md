# 02 — Customer Acquisition Strategy

> Context: beachhead = boutique dental/beauty/pratama clinics, one metro, WhatsApp-first (see `01-Beachhead-Market.md`). Labels: [Fact — vendor], [Fact — official], [Fact — independent/secondary], [Interpretation]. Every number carries its source URL.

## 1. Motion: sales-assisted pilots first, self-serve later

- First 20 customers are sales-assisted because slot-rule mapping (duration, buffer, staff, cancel policy) cannot be self-served on day one — [Interpretation] carried from `docs/enterprise/07-Go-to-Market-Strategy.md` §7.4.
- Self-serve unlocks only after: one PMS integration is stable + one vertical rule template exists + one quantitative case study is published — [Interpretation] (same source).
- Generic SMB SaaS search results observed in this research (Tomasz Tunguz on Microsoft SMB channel; SaaStr "Next Wave of SMB SaaS"; BVP "ascent of SMB SaaS") are US-centric thought leadership, NOT Indonesia clinic playbooks — [Fact — independent/secondary, limited transferability]:
  - https://www.linkedin.com/pulse/most-successful-smb-saas-acquisition-channel-ever-built-tomasz-tunguz
  - https://www.saastr.com/the-next-wave-of-smb-saas/
  - https://www.bvp.com/atlas/moving-upmarket-and-the-ascent-of-smb-saas
- Do not cite them as evidence that any single channel works for Indonesian clinics.

## 2. Channels (ranked, with conflicts shown)

### P0 — PMS reseller / implementer-led pilots (highest intent)

- Fact: Indonesian clinic SaaS is sold per-outlet with named packages (KlinikPintar "Siap Rp300ribu/bulan" — [Fact — vendor] https://klinikpintar.id/aplikasiklinik/faskes/klinik-kecantikan ; ICONIX Rp475–675rb — [Fact — vendor] https://www.iconix.id/hcantik.html?srsltid=AU7gw4XPNHH4TKv5JrcBnndliyN-0DwuFewAJK2skxKKMRZdP0LRYXoI), which implies a reseller/implementer footprint exists wherever the PMS is sold — [Interpretation].
- Play: 2–3 reseller conversations → one co-pilot offer ("free 30-day reschedule pilot for 3 of your live outlets, we need baseline exports") → reseller gets co-branded case study.
- Conflict: no reseller commission schedule or partner-program page was found for KlinikPintar/ICONIX in this research — do not assume rev-share exists. Validation: ask directly.
- Metric to earn the channel: reseller-sourced pilot → paid conversion ≥ 1 of 3 within 60 days, else drop the reseller — [Assumption to validate].

### P0 — Direct outbound to 50-outlet cluster (founder-led)

- Play: build a 50-row list (maps + PMS customer stories + walk-in), filter by the 5 beachhead criteria, founder visits/calls with a one-page pilot offer. Entry condition: prospect shares 4 weeks of appointment logs (no-show, cancel, missed-call baseline) — per `enterprise/07` §7.2.
- Why direct first: associations and BSPs do not sell for you before you have proof — [Interpretation]. Direct produces the case study that unlocks everything else.
- Cost guardrail: generic CAC-payback benchmarks (median 16 months; SMB 8–12 — [Fact — secondary benchmark] https://www.getaleph.com/answers/cac-payback-period-saas-2026) are NOT vertical targets; use them only to reject a motion that cannot pay back in <6 months on Rp300–675rb/mo ARPU — [Interpretation].

### P1 — Association chapter (single chapter, not national)

- Fact: ARSSI exists as a real hospital association channel ([Fact — official] https://arssi.id/), but it serves hospitals — the DEFERRED segment. No dental/beauty association rate card, member count, or vendor-slot terms were found in this research.
- Play (bounded): one chapter talk or workshop ("we recovered X slots in 30 days at 3 clinics like yours") + QR to pilot waitlist. No national sponsorship until one chapter converts ≥2 pilots — [Assumption to validate].
- Conflict: association reach is assumed, not observed. Do not forecast pipeline from associations.

### P1 — BSP co-marketing (credibility, not leads)

- Facts: Mekari Qontak is an official Meta BSP in Indonesia — [Fact — vendor] https://mekari.com/en/qontak/whatsapp-business-api/ ; Qiscus describes itself as official partner and documents adapting plans to Meta pricing changes — [Fact — vendor] https://www.qiscus.com/en/blog/qiscus-plan-improvements-to-welcome-whatsapp-business-api-pricing-changes/ ; Wati compares Qontak/Qiscus/Wati/Tyntec for Indonesia — [Fact — vendor, comparison bias] https://www.wati.io/en/blog/top-5-whatsapp-business-api-tools-in-indonesia/.
- Play: pick the BSP you actually send through; ask for (a) solution-directory listing, (b) one joint webinar/post, (c) template-approval fast-lane guidance. Expect logo credibility, not pipeline — [Interpretation].
- Conflict: BSPs sell messaging volume; a no-show-recovery agent that REDUCES wasted templates is not their natural upsell. Align on "more kept appointments = more paid conversations" or the incentive misaligns — [Interpretation].

### P2 (deferred) — Paid ads / marketplace listings / multi-city expansion

- Deferred until CAC payback <6 months is measured on P0. Generic SMB churn (3–5%/mo logo — [Fact — secondary] https://optif.ai/learn/questions/b2b-saas-churn-rate-benchmark/) says paid acquisition on low ARPU churns out — [Interpretation].

## 3. Pilot offer (the only "campaign" that matters now)

- Offer: 30-day pilot, 3–5 outlets, discounted or free ONLY in exchange for (a) 4-week baseline export, (b) staff WhatsApp thread access for reply handling, (c) permission to publish recovered-slot counts.
- Proof artifact: one-page case study = baseline no-show/cancel → recovered slots → recovered revenue (slot value from the clinic's own price list, NOT vendor ROI calculators) → staff minutes saved. Vendor ROI calculators (MyBCAT miss rates, Peerlogic/Dentina $151k/year, OmniMD 3–8x claims per `01-Strategy/06-Business-Model-and-Pricing.md` §6.4) are illustration only — do not quote them as the pilot's result.
- Kill rule: if 3 pilots produce no measurable recovered-slot delta vs baseline, stop acquisition and fix the product (slot-hold + write-back + reminder purity) before spending on channels — [Interpretation].

## 4. Uncertainty + validation required

- Unknown: dental/beauty association inventory (name, chapter size, vendor terms) — needs one primary call.
- Unknown: PMS reseller economics (margin, exclusivity) — needs reseller interviews.
- Unknown: founder-direct conversion rate and sales cycle in IDR terms — needs the first 50-outlet sprint log.
- Sources: inline URLs only; no invented citations. Vendor vs secondary vs interpretation labeled throughout.
