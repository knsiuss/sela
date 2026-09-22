---
name: sela-wa-template-compliance
description: WhatsApp template classification and opt-in rules (Meta 2026). Use before sending any template or blast.
---

# WA Template Compliance

1. Every template has exactly one category: marketing, utility, or authentication.
2. One promo line inside a utility template reclassifies the whole message as MARKETING (6-9x cost + opt-in required). Reminders are utility-PURE.
3. Utility/auth inside the 24h window are billable since 1 Oct 2026; only 1,000 service messages/month/number are free.
4. Log opt-in/opt-out per number, separate from clinical data.
5. Check `message_template_quality_update` webhooks; paused template = stop blast immediately, switch to approved fallback.
6. Never quote IDR rates from memory — read the live Meta rate card per campaign.
