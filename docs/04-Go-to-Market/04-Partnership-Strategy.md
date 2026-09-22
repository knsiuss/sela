# 04 — Partnership Strategy

> Principle: one deep integration + co-marketing beats five logos (from `docs/enterprise/07-Go-to-Market-Strategy.md` §7.5). Labels: [Fact — official], [Fact — vendor], [Fact — independent/secondary], [Interpretation]. Every number carries its source URL.

## 1. Partner map (what exists, what is claimed)

| Partner type | Facts | What is NOT known |
|---|---|---|
| WhatsApp BSP (message pipe + credibility) | Meta defines two partner roles — tech partners vs solution partners — [Fact — official] https://whatsappbusiness.com/partners/become-a-partner/ ; Solution Partners provide full WhatsApp Platform services — [Fact — official] https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/overview. In Indonesia: Mekari Qontak is an official BSP — [Fact — vendor] https://mekari.com/en/qontak/whatsapp-business-api/ ; Qiscus is an official partner adapting plans to Meta price changes — [Fact — vendor] https://www.qiscus.com/en/blog/qiscus-plan-improvements-to-welcome-whatsapp-business-api-pricing-changes/ ; 360dialog positions as official BSP + ISV/reseller enabler — [Fact — vendor] https://360dialog.com/partners. | No BSP publishes a standard rev-share or referral fee on the pages observed. Third-party "up to 30% recurring revenue share / $15k avg commission" claims (e.g., WapsChat partner page found in search) are [Fact — vendor claim, weak, non-Meta] — do not treat as market rate. BSP platform fees, setup fees, and support SLAs vary by BSP and were not fully compared here. |
| PMS / clinic SaaS (write-back moat) | Observed PMS vendors with per-outlet packaging: KlinikPintar (Rp300rb/mo "Siap" tier) — [Fact — vendor] https://klinikpintar.id/aplikasiklinik/faskes/klinik-kecantikan ; ICONIX beauty tiers Rp475–675rb — [Fact — vendor] https://www.iconix.id/hcantik.html?srsltid=AU7gw4XPNHH4TKv5JrcBnndliyN-0DwuFewAJK2skxKKMRZdP0LRYXoI. Moat thesis: trusted calendar write-back (idempotent rebook, audit trail, cancel-policy enforcement) per PMS creates switching cost — [Interpretation] from `04-Competitive-Landscape.md`. | No public API/write-back documentation, app-marketplace listing terms, or revenue-share schedule was verified for these PMS vendors in this research. Do not commit to a PMS until API docs + sandbox + a reseller intro call are in hand. |
| Association (distribution) | ARSSI (private hospitals) is a real association with public secretariat contact — [Fact — official] https://arssi.id/ and https://arssipusat.org/ — but serves the DEFERRED hospital segment. | Dental/beauty association equivalent with vendor-program terms: NOT found. No member counts, sponsorship rates, or conversion data observed. |
| Generic SaaS channel wisdom | Reseller/channel readiness and SMB SaaS "move upmarket" essays observed (PartnerStack; BVP) — [Fact — independent/secondary]: https://partnerstack.com/articles/the-path-to-saas-channel-readiness-reseller-partners ; https://www.bvp.com/atlas/moving-upmarket-and-the-ascent-of-smb-saas. | US/framework-level content; no Indonesia clinic reseller economics. Use as checklist, not evidence. |

## 2. Playbook (sequenced, smallest safe step)

1. **Pick one PMS, go deep (P0).** Ask: API docs, write-back scope (create/move/cancel + waitlist), sandbox, rate limits, BAA/PDP posture, marketplace listing requirements, reseller intro. Deliverable: one live write-back integration + one joint one-pager. Stop adding a second PMS until the first has ≥3 paying outlets — [Interpretation].
2. **Pick the BSP you send through (P0).** Criteria: IDR billing clarity (VAT-inclusive invoicing), template-approval support, throughput for reminder bursts, directory listing. Get: listing + one joint post/webinar + escalation contact. Expect credibility, not pipeline (see `02-Customer-Acquisition-Strategy.md`) — [Interpretation].
3. **One association chapter pilot (P1).** Offer a workshop + pilot waitlist, not a national sponsorship. Convert ≥2 pilots before spending further — [Assumption to validate].
4. **Co-marketing asset (the only joint deliverable that matters):** the one-page recovered-slot case study (baseline → recovered → revenue math from the clinic price list). No joint ROI calculator built on vendor assumptions — [Interpretation].
5. **Defer:** multi-BSP abstraction, multi-PMS connector platform, national association deals, paid reseller network with fixed rev-share — until unit economics (message purity %, COGS/msg, recovery rate) are measured over 5 pilots.

## 3. Terms to negotiate (checklist, not agreed terms)

- Data: baseline export + ongoing appointment feed; opt-in/opt-out logging ownership; PDP (UU PDP No. 27/2022) responsibilities per party.
- Commercial: pilot fee vs free-with-data; post-pilot list price owner (you); whether PMS/BSP takes margin or flat referral; no exclusivity before 20 paying outlets — [Interpretation].
- Technical: write-back idempotency key ownership; double-book liability rule; human-handoff SLA ("ketik OPERATOR" + staff summary per `05-Product-Vision` §5.4).
- Brand: co-logo use limited to the measured case study; no joint efficacy claims beyond the observed pilot numbers.

## 4. Uncertainty + validation required

- Unknown: PMS API depth, reseller margin expectations, BSP referral economics, association vendor terms — each needs one primary conversation; nothing in this research substitutes for it.
- Risk: BSP incentive (volume) vs your value (fewer wasted messages) can misalign — address explicitly in the first BSP call.
- Sources: inline URLs only; vendor claims vs official Meta docs vs interpretation labeled; no invented citations or terms.
