# WhatsApp Cloud API — Research Notes

> Status: verified-against-official-docs (23 Sep 2026). Vendor/BSP figures: UNVERIFIED.
> Companion index: `docs/03-Technical/04-Integrations.md` section A.

## Decision addressed

Can the builder proceed with a direct WhatsApp Cloud API integration (WABA setup flow,
template lifecycle, webhook verification, pricing model including the IDR rate card),
and what remains unverified about Indonesia BSP options and markup?

## Scope and question

- In scope: Meta-official setup flow, template creation/review/status rules, webhook
  verification mechanics, per-message pricing model and IDR rate-card existence.
- Out of scope: message copy, product requirements, vendor selection, production
  hardening steps (left to the builder).
- Assumption: direct Cloud API integration first (no BSP), consistent with the build
  order in `docs/03-Technical/04-Integrations.md`.

## Findings

### 1. Setup flow (VERIFIED — official get-started guide)

1. Prerequisites: Facebook or managed Meta account, developer registration,
   WhatsApp-enabled device for test messages.
2. Create a Meta app with the **Connect with customers through WhatsApp** use case,
   attached to a business portfolio.
3. In API Setup, connect or create a WhatsApp Business Account (record the WABA ID),
   pick a From number, generate a temporary token, and send the first test message.
4. Set up the test echo-bot webhook app to observe inbound payloads, then reply in the
   chat thread to see the `whatsapp_business_account` / `messages` payload.
5. For anything beyond a quick test, create a system user and a permanent token with
   `business_management`, `whatsapp_business_messaging`, and
   `whatsapp_business_management`.
6. Replying opens a 24-hour customer service window (CSW), inside which non-template
   messages are allowed, sent via
   `POST https://graph.facebook.com/<VERSION>/<PHONE_NUMBER_ID>/messages`
   (the guide example used `v23.0`; use the current Graph version at build time).

### 2. Template lifecycle (VERIFIED — official template docs)

- Creation via Message Templates API or WhatsApp Manager; **maximum 100 templates
  per WABA per hour**.
- Name: lowercase alphanumeric plus underscores, max 512 chars; names are not unique
  across languages.
- `category` is REQUIRED: `marketing` | `utility` | `authentication`; category drives
  pricing, and miscategorized templates can be re-categorized or restricted.
- `parameter_format`: `named` (e.g. `{{first_name}}`) or `positional`
  (e.g. `{{1}}`); default is `positional`.
- Templates are auto-reviewed on create/edit (review can take up to 24h); status must
  be `APPROVED` before sending. Status changes arrive via
  `message_template_status_update` webhooks or via `GET <TEMPLATE_ID>?fields=status`.
- Capacity: 250 templates per WABA under an unverified portfolio; up to 6,000 per WABA
  when the portfolio is verified and at least one number has an approved display name.
- Delivery guardrails exist independently of approval: messaging limits, template
  pacing, pausing on poor quality feedback, archival after 12+ months inactive, and
  per-user marketing caps.

### 3. Webhook verification (VERIFIED — official webhooks docs)

- Endpoint must serve HTTPS (valid cert, self-signed not accepted) and handle two
  request types.
- Verification: Meta sends `GET ?hub.mode=subscribe&hub.challenge=<int>&hub.verify_token=<string>`;
  the endpoint must check `hub.verify_token` against the App Dashboard value and
  respond with the `hub.challenge` value.
- Events: `POST` JSON with `object: "whatsapp_business_account"` and an `entry[]`
  array; validate `X-Hub-Signature-256` (SHA256 over the payload with the App Secret).
- Always respond `200 OK`; WhatsApp retries failed deliveries with decreasing
  frequency for up to 7 days, so the receiver must deduplicate. Payloads can reach
  3 MB. Some webhooks require the app to be in Live mode.
- Subscribe per field in App Dashboard (WhatsApp > Configuration). Minimum set for
  this project: `messages` (needs `whatsapp_business_messaging`), plus
  `message_template_status_update` and `account_update` (need
  `whatsapp_business_management`). Billing signal arrives in status webhooks as
  `pricing: {billable, pricing_model, type, category}`; volume-tier upgrades arrive as
  `account_update` with `event: VOLUME_BASED_PRICING_TIER_UPDATE`.
- mTLS with client CN `client.webhooks.fbclientcerts.com` is supported and optional.

### 4. Pricing model + IDR card (VERIFIED existence; values UNKNOWN)

- Per-message billing effective 1 Jul 2025: only **delivered** template messages
  (`"type": "template"`) are charged. Non-template messages inside an open CSW are
  free; utility templates delivered inside an open CSW are free; free-entry-point
  windows give 72h free messaging after a qualifying ad/page entry.
- Rate = template category x recipient calling-code market x volume tier. Volume tiers
  apply to utility/authentication only, aggregate at business-portfolio level across
  all WABAs, and reset monthly at 12am WABA timezone.
- Rate cards are published per currency and updated at most quarterly (1 Jan / 1 Apr /
  1 Jul / 1 Oct) with 1/3/6-month notice depending on change type.
- **IDR rate card existence VERIFIED**: the pricing page rate-card table contains an
  `IDR` row (rates + volume tiers, CSV and PDF), current cards effective 1 Jul 2026.
  Indonesia (calling code 62) is a standalone market, not a regional bucket.
- **Numeric IDR rates: UNKNOWN** — CSV/PDF cell values were not extracted in this
  pass. Read them live from the pricing page before any cost estimate. Never quote a
  per-message rupiah figure from memory.

### 5. Indonesia BSP options + markup (UNVERIFIED)

- A Firecrawl web search returned only vendor marketing pages (pricing pages, blogs,
  a provider listicle). These are vendor claims, not primary sources; no vendor is
  endorsed here and no per-vendor figure is repeated as fact.
- **BSP list for Indonesia: UNVERIFIED. Per-message markup over Meta rates:
  UNVERIFIED (UNKNOWN).** Until BSP contracts/docs are checked, assume nothing beyond
  Meta pass-through rates plus an undisclosed platform fee — and treat even that as an
  assumption, not a finding.

## Recommendation

Proceed with **direct Cloud API, utility-template-first**: system-user token, webhook
receiver for `messages` + template/account updates, log the `pricing` tag on every
status webhook, idempotent send keyed on `phone_number_id` + business message id.
Defer any BSP commitment until BSP pricing docs are verified line-by-line. Read the
live IDR CSV before estimating unit cost.

## Assumptions and limitations

- Official docs fetched 23 Sep 2026; Meta may change rates, limits, or field names —
  re-check the pricing and template pages at build time.
- Firecrawl Cloud search rate-limited this session (observed 429), so vendor-side
  discovery was shallow by design; BSP research needs its own pass against BSP
  primary docs.
- No test WABA, phone number, or token was provisioned; send-path claims are
  doc-verified, not live-verified.

## Sources

- WhatsApp Cloud API Get Started — https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started
- Pricing on the WhatsApp Business Platform — https://developers.facebook.com/docs/whatsapp/pricing
- Template fundamentals — https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview
- Template categorization (via Firecrawl search result) — https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-categorization
- WhatsApp webhooks overview — https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview
- Get started with webhooks (verification + signature) — https://developers.facebook.com/docs/graph-api/webhooks/getting-started
- WhatsApp Business Platform pricing page (vendor-neutral rate-card index, observed via search) — https://whatsappbusiness.com/products/platform-pricing/
- Vendor-claim pages observed via Firecrawl search, UNVERIFIED, no endorsement: Wati pricing — https://www.wati.io/pricing/ ; Qiscus pricing-change blog — https://www.qiscus.com/en/blog/qiscus-plan-improvements-to-welcome-whatsapp-business-api-pricing-changes/ ; Wati pricing guide — https://www.wati.io/en/blog/whatsapp-api-pricing-guide/ ; YCloud Indonesia provider listicle — https://www.ycloud.com/blog/top-whatsapp-business-api-solution-providers-indonesia

## Blocker

- None for direct Cloud API build. BSP selection remains blocked until primary BSP
  pricing/contract docs are verified (exact decision needed: direct-only vs named BSP).
