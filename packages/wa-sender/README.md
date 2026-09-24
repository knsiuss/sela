# @repo/wa-sender

A dependency-free TypeScript boundary for the WhatsApp Cloud API. The package uses native `fetch`, keeps provider I/O behind `WhatsAppTransport`, and defaults to utility templates that must be registered before sending.

## Boundary

- `WhatsAppSender` validates untrusted messages, derives a deterministic idempotency key, applies the 24-hour/template and confirmation policies, and calls the transport at most once for concurrent identical work.
- `MetaGraphTransport` sends one request to a configured HTTPS Graph API URL. It uses an injected `AbortSignal.timeout` boundary and never retries automatically.
- `InMemoryTransport` supports deterministic local smoke tests without network I/O; it is not a production transport.
- `TemplateRegistry` accepts utility templates only, rejects promotional content, and rejects duplicate or unknown definitions.
- Interactive reply buttons are limited to deterministic quick replies; template buttons remain registry-controlled.
- `InMemoryTransport` provides a deterministic, defensive local double without network I/O.
- `normalize_delivery_receipts` accepts a Meta status message or nested webhook status data and returns only WAMID, delivery state, safe timestamp, pricing fields, and a safe provider error code.

The package has no runtime dependencies. It does not import `apps/*` and does not read credentials from the environment implicitly; the host supplies a tenant-scoped access token through constructor options or a secret provider.

## Minimal usage

```ts
import {
  MetaGraphTransport,
  WhatsAppSender,
  type MetaGraphTransportOptions,
} from "@repo/wa-sender";

declare const supplied_by_secret_manager: string;

const transport_options: MetaGraphTransportOptions = {
  graph_api_url: "https://graph.facebook.com/v23.0",
  phone_number_id: "configured-phone-number-id",
  access_token: supplied_by_secret_manager,
  request_timeout_ms: 10_000,
};
const sender = new WhatsAppSender(new MetaGraphTransport(transport_options));

const result = await sender.send({
  to: "+12025550100",
  type: "template",
  template: {
    name: "appointment_reminder",
    language: { code: "en_US" },
    components: [{ type: "body", parameters: [{ type: "text", text: "2026-10-01 09:00" }] }],
  },
  inbound_wamid: "inbound-message-id",
  turn_id: "reminder-1",
});
```

Use a tenant-specific transport or sender per credential scope. Do not log the access token, full recipient number, inbound contact profile, or raw provider response body.

## Policies

`template_required: true` on a send, or `template_required` on the message, rejects free-form text. Outside the 24-hour customer service window, use `requires_template(now, last_inbound)` from `window.ts` to select a template.

Messages marked `requires_confirmation: true` or `is_state_changing: true` are rejected unless the sender receives an explicit `confirmation_policy` that returns `true`. The default is fail-closed; a boolean flag alone is not proof of consent.

An explicit `idempotency_key` takes precedence. Otherwise the package hashes `inbound_wamid + turn_id`; with neither identity, it hashes canonical semantic content. The default coordinator uses a bounded, expiring in-memory store and suppresses concurrent duplicates. A different payload under the same key fails with `idempotency_conflict`.

The default cache is process-local. A durable `IdempotencyPort` adapter must provide its own cross-process atomicity and namespace keys by tenant/phone number, and a process crash or uncertain upstream timeout can still leave the provider outcome unknown; callers must reconcile before retrying.

## Status receipts

```ts
import { normalize_delivery_receipts } from "@repo/wa-sender";

const receipts = normalize_delivery_receipts(webhook_value);
// Each receipt contains only safe normalized fields.
```

Malformed status or pricing data is rejected with a typed `BillingNormalizationError`; `try_normalize_delivery_receipt` is available when a webhook consumer needs to ignore one malformed item explicitly.

## Verification

From the repository root:

```text
pnpm --filter @repo/wa-sender typecheck
pnpm --filter @repo/wa-sender test
```

The transport intentionally does not decide whether a caller is authorized to perform a state-changing action. The integrating application must establish tenant ownership, consent evidence, and the confirmation policy before invoking the sender.

## Sources

- WhatsApp service messages and customer-service windows: https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages
- WhatsApp Cloud API setup and message endpoint: https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started
- WhatsApp template fundamentals: https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview
