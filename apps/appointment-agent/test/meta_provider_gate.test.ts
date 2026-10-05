import { describe, expect, it, vi } from "vitest";
import { is_service_window_open } from "../src/agent_types.js";
import { InMemoryMessageDedupe } from "../src/ingress/dedupe.js";
import { MetricsRegistry } from "../src/observability/metrics.js";
import { InMemoryTenantResolver } from "../src/ingress/tenant_resolver.js";
import { is_valid_signature } from "../src/ingress/verify.js";
import {
  APPROVED_TEMPLATES_ENV,
  ApprovedTemplateConfigError,
  parse_approved_templates,
  require_approved_template,
} from "../src/meta/approved_templates.js";
import { classify_provider_error, classify_sender_code } from "../src/meta/provider_error_map.js";
import {
  build_handoff_webhook,
  build_interactive_reply_webhook,
  build_legacy_button_webhook,
  build_status_webhook,
  build_text_webhook,
  FIXTURE_APP_SECRET,
  FIXTURE_PHONE_NUMBER_ID,
  sign_fixture,
} from "../src/meta/provider_fixtures.js";
import {
  load_staging_smoke_config,
  missing_live_requirements,
  run_offline_smoke,
} from "../src/meta/staging_smoke.js";
import { InMemoryOutboundLedgerStore } from "../src/outbound/outbound_ledger.js";
import { handle_inbound_request, WebhookSignatureError } from "../src/webhook_handler.js";

const TENANT_ID = "42";

function resolver(): InMemoryTenantResolver {
  return new InMemoryTenantResolver({ [FIXTURE_PHONE_NUMBER_ID]: TENANT_ID });
}

function queue_spy(): { enqueue: (job: never) => Promise<void>; jobs: unknown[] } {
  const jobs: unknown[] = [];
  return {
    jobs,
    enqueue: async (job: never): Promise<void> => {
      jobs.push(job);
    },
  };
}

describe("P0.8 signed webhook smoke path with live-shaped payloads", () => {
  it("accepts a signed inbound text payload through the HMAC path", async () => {
    const body = build_text_webhook({ wamid: "wamid.gate.text.1" });
    const queue = queue_spy();
    const result = await handle_inbound_request(
      body,
      sign_fixture(body, FIXTURE_APP_SECRET),
      FIXTURE_APP_SECRET,
      new InMemoryMessageDedupe(),
      queue,
      { tenant_resolver: resolver() },
    );
    expect(result).toMatchObject({ received_count: 1, enqueued_count: 1, duplicate_count: 0 });
    expect(queue.jobs).toHaveLength(1);
  });

  it("rejects a tampered live-shaped payload before parsing", async () => {
    const body = build_text_webhook({ wamid: "wamid.gate.text.2" });
    await expect(handle_inbound_request(
      `${body} `,
      sign_fixture(body, FIXTURE_APP_SECRET),
      FIXTURE_APP_SECRET,
      new InMemoryMessageDedupe(),
      queue_spy(),
      { tenant_resolver: resolver() },
    )).rejects.toBeInstanceOf(WebhookSignatureError);
    expect(is_valid_signature(`${body} `, sign_fixture(body, FIXTURE_APP_SECRET), FIXTURE_APP_SECRET)).toBe(false);
  });

  it("ingests legacy button and interactive replies as button_reply turns", async () => {
    const legacy_body = build_legacy_button_webhook({ wamid: "wamid.gate.legacy.1" });
    const interactive_body = build_interactive_reply_webhook({ wamid: "wamid.gate.interactive.1" });
    const legacy = await handle_inbound_request(
      legacy_body,
      sign_fixture(legacy_body, FIXTURE_APP_SECRET),
      FIXTURE_APP_SECRET,
      new InMemoryMessageDedupe(),
      queue_spy(),
      { tenant_resolver: resolver() },
    );
    const interactive = await handle_inbound_request(
      interactive_body,
      sign_fixture(interactive_body, FIXTURE_APP_SECRET),
      FIXTURE_APP_SECRET,
      new InMemoryMessageDedupe(),
      queue_spy(),
      { tenant_resolver: resolver() },
    );
    expect(legacy).toMatchObject({ received_count: 1, enqueued_count: 1 });
    expect(interactive).toMatchObject({ received_count: 1, enqueued_count: 1 });
  });

  it("counts a redelivered provider payload as a duplicate without requeueing", async () => {
    const body = build_text_webhook({ wamid: "wamid.gate.duplicate.1" });
    const dedupe = new InMemoryMessageDedupe();
    const queue = queue_spy();
    const options = { tenant_resolver: resolver() };
    const first = await handle_inbound_request(
      body, sign_fixture(body, FIXTURE_APP_SECRET), FIXTURE_APP_SECRET, dedupe, queue, options,
    );
    const second = await handle_inbound_request(
      body, sign_fixture(body, FIXTURE_APP_SECRET), FIXTURE_APP_SECRET, dedupe, queue, options,
    );
    expect(first).toMatchObject({ enqueued_count: 1, duplicate_count: 0 });
    expect(second).toMatchObject({ enqueued_count: 0, duplicate_count: 1 });
    expect(queue.jobs).toHaveLength(1);
  });

  it("ingests the operator handoff text as a queued turn", async () => {
    const body = build_handoff_webhook();
    const queue = queue_spy();
    const result = await handle_inbound_request(
      body,
      sign_fixture(body, FIXTURE_APP_SECRET),
      FIXTURE_APP_SECRET,
      new InMemoryMessageDedupe(),
      queue,
      { tenant_resolver: resolver() },
    );
    expect(result).toMatchObject({ received_count: 1, enqueued_count: 1 });
    expect(queue.jobs).toHaveLength(1);
  });
});

describe("tenant resolution against Meta's documented payload shape", () => {
  const ACCOUNT_ID = "106540352242922";

  function envelope(value: Record<string, unknown>): string {
    return JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: "0", changes: [{ field: "messages", value }] }],
    });
  }

  function text_value(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
    return {
      messaging_product: "whatsapp",
      ...(metadata === undefined ? {} : { metadata }),
      messages: [{
        from: "15550001111",
        id: "wamid.shape.text.1",
        timestamp: "1780000000",
        type: "text",
        text: { body: "I want to reschedule my appointment" },
      }],
    };
  }

  it("resolves and enqueues when phone_number_id exists only under metadata", async () => {
    const queue = queue_spy();
    const body = envelope(text_value({ display_phone_number: "15550783881", phone_number_id: ACCOUNT_ID }));

    const result = await handle_inbound_request(
      body,
      sign_fixture(body, FIXTURE_APP_SECRET),
      FIXTURE_APP_SECRET,
      new InMemoryMessageDedupe(),
      queue,
      { tenant_resolver: new InMemoryTenantResolver({ [ACCOUNT_ID]: TENANT_ID }) },
    );

    expect(result).toMatchObject({ received_count: 1, enqueued_count: 1, unresolved_count: 0 });
    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]).toMatchObject({ tenant_id: TENANT_ID });
  });

  it("does not resolve a payload whose only phone_number_id sits at the top level", async () => {
    const queue = queue_spy();
    const body = envelope({ ...text_value(undefined), phone_number_id: ACCOUNT_ID });

    const result = await handle_inbound_request(
      body,
      sign_fixture(body, FIXTURE_APP_SECRET),
      FIXTURE_APP_SECRET,
      new InMemoryMessageDedupe(),
      queue,
      { tenant_resolver: new InMemoryTenantResolver({ [ACCOUNT_ID]: TENANT_ID }) },
    );

    expect(result).toMatchObject({ received_count: 1, enqueued_count: 0, unresolved_count: 1 });
    expect(queue.jobs).toHaveLength(0);
  });

  it("resolves a statuses callback whose phone_number_id exists only under metadata", async () => {
    const ledger = new InMemoryOutboundLedgerStore();
    const claim = await ledger.begin({
      tenant_id: TENANT_ID,
      provider: "whatsapp",
      operation_key: "shape-status-operation",
      request_fingerprint: "c".repeat(64),
    });
    if (claim.kind !== "send") throw new Error("ledger claim setup failed");
    await ledger.mark_sent({
      tenant_id: TENANT_ID,
      provider: "whatsapp",
      operation_key: "shape-status-operation",
      lease_token: claim.lease_token,
      provider_message_id: "wamid.shape.status.1",
    });
    const body = envelope({
      messaging_product: "whatsapp",
      metadata: { display_phone_number: "15550783881", phone_number_id: ACCOUNT_ID },
      statuses: [{ id: "wamid.shape.status.1", status: "delivered", timestamp: "1780000300" }],
    });

    const result = await handle_inbound_request(
      body,
      sign_fixture(body, FIXTURE_APP_SECRET),
      FIXTURE_APP_SECRET,
      new InMemoryMessageDedupe(),
      queue_spy(),
      {
        tenant_resolver: new InMemoryTenantResolver({ [ACCOUNT_ID]: TENANT_ID }),
        outbound_ledger: ledger,
      },
    );

    expect(result).toMatchObject({ status_count: 1, status_updated_count: 1, unresolved_count: 0 });
    expect(ledger.get(TENANT_ID, "whatsapp", "shape-status-operation")?.status).toBe("delivered");
  });

  it("does not resolve a statuses callback whose account id sits at the top level", async () => {
    const ledger = new InMemoryOutboundLedgerStore();
    const claim = await ledger.begin({
      tenant_id: TENANT_ID,
      provider: "whatsapp",
      operation_key: "shape-status-unknown",
      request_fingerprint: "d".repeat(64),
    });
    if (claim.kind !== "send") throw new Error("ledger claim setup failed");
    await ledger.mark_sent({
      tenant_id: TENANT_ID,
      provider: "whatsapp",
      operation_key: "shape-status-unknown",
      lease_token: claim.lease_token,
      provider_message_id: "wamid.shape.status.2",
    });
    const body = envelope({
      messaging_product: "whatsapp",
      phone_number_id: ACCOUNT_ID,
      statuses: [{ id: "wamid.shape.status.2", status: "delivered", timestamp: "1780000300" }],
    });

    const result = await handle_inbound_request(
      body,
      sign_fixture(body, FIXTURE_APP_SECRET),
      FIXTURE_APP_SECRET,
      new InMemoryMessageDedupe(),
      queue_spy(),
      {
        tenant_resolver: new InMemoryTenantResolver({ [ACCOUNT_ID]: TENANT_ID }),
        outbound_ledger: ledger,
      },
    );

    expect(result).toMatchObject({ status_count: 1, status_updated_count: 0, unresolved_count: 1 });
    expect(ledger.get(TENANT_ID, "whatsapp", "shape-status-unknown")?.status).toBe("sent");
  });
});

describe("tenant-resolution observability", () => {
  const ACCOUNT_ID = "106540352242922";
  const RESOLUTION_METRIC = "webhook_tenant_resolution_total";

  function body_with(value: Record<string, unknown>): string {
    return JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: "0", changes: [{ field: "messages", value }] }],
    });
  }

  function text_value(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      messaging_product: "whatsapp",
      metadata: { phone_number_id: ACCOUNT_ID },
      messages: [{
        from: "15550001111",
        id: "wamid.observability.1",
        timestamp: "1780000000",
        type: "text",
        text: { body: "I want to reschedule my appointment" },
      }],
      ...extra,
    };
  }

  async function deliver(
    metrics: MetricsRegistry,
    value: Record<string, unknown>,
    mappings: Record<string, string> = { [ACCOUNT_ID]: TENANT_ID },
  ): Promise<void> {
    const body = body_with(value);
    await handle_inbound_request(
      body,
      sign_fixture(body, FIXTURE_APP_SECRET),
      FIXTURE_APP_SECRET,
      new InMemoryMessageDedupe(),
      queue_spy(),
      { tenant_resolver: new InMemoryTenantResolver(mappings), metrics },
    );
  }

  it("meters a resolved delivery separately from an unreadable channel account", async () => {
    const resolved_metrics = new MetricsRegistry();
    await deliver(resolved_metrics, text_value());
    expect(resolved_metrics.counter_value(RESOLUTION_METRIC, { result: "resolved" })).toBe(1);
    expect(resolved_metrics.counter_value(RESOLUTION_METRIC, { result: "channel_account_missing" })).toBe(0);

    const missing_metrics = new MetricsRegistry();
    await deliver(missing_metrics, text_value({ metadata: undefined, phone_number_id: ACCOUNT_ID }));
    expect(missing_metrics.counter_value(RESOLUTION_METRIC, { result: "channel_account_missing" })).toBe(1);
    expect(missing_metrics.counter_value(RESOLUTION_METRIC, { result: "resolved" })).toBe(0);

    const unknown_metrics = new MetricsRegistry();
    await deliver(unknown_metrics, text_value(), { "999999999999999": "77" });
    expect(unknown_metrics.counter_value(RESOLUTION_METRIC, { result: "unknown_channel" })).toBe(1);
    expect(unknown_metrics.counter_value(RESOLUTION_METRIC, { result: "resolved" })).toBe(0);
  });

  it("meters a status callback that cannot resolve its channel account", async () => {
    const ledger = new InMemoryOutboundLedgerStore();
    const metrics = new MetricsRegistry();
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{
        id: "0",
        changes: [{
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            phone_number_id: ACCOUNT_ID,
            statuses: [{ id: "wamid.observability.status", status: "delivered", timestamp: "1780000300" }],
          },
        }],
      }],
    });

    const result = await handle_inbound_request(
      body,
      sign_fixture(body, FIXTURE_APP_SECRET),
      FIXTURE_APP_SECRET,
      new InMemoryMessageDedupe(),
      queue_spy(),
      {
        tenant_resolver: new InMemoryTenantResolver({ [ACCOUNT_ID]: TENANT_ID }),
        outbound_ledger: ledger,
        metrics,
      },
    );

    expect(result).toMatchObject({ status_count: 1, unresolved_count: 1 });
    expect(metrics.counter_value(RESOLUTION_METRIC, { result: "channel_account_missing" })).toBe(1);
  });

  it("logs a bounded warning carrying no account id, tenant id, phone, or body", async () => {
    const metrics = new MetricsRegistry();
    const warn_spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let lines: Record<string, unknown>[] = [];
    try {
      await deliver(metrics, text_value({ metadata: undefined, phone_number_id: ACCOUNT_ID }));
      lines = warn_spy.mock.calls.map((args) => JSON.parse(String(args[0])) as Record<string, unknown>);
    } finally {
      warn_spy.mockRestore();
    }

    expect(lines).toHaveLength(1);
    // Asserted on the parsed field set, not by substring: the tenant id is a
    // short numeric string that can also occur inside the random request id.
    expect(Object.keys(lines[0]!).sort()).toEqual([
      "event",
      "reason",
      "request_id",
      "unresolved_count",
    ]);
    expect(lines[0]).toMatchObject({
      event: "webhook_tenant_resolution_incomplete",
      reason: "channel_account_missing",
      unresolved_count: 1,
    });
    expect(String(lines[0]!["request_id"])).toMatch(/^[0-9a-f-]{36}$/u);

    const serialized = JSON.stringify(lines);
    for (const secret of [ACCOUNT_ID, "15550001111", "I want to reschedule my appointment"]) {
      expect(metrics.render_prometheus()).not.toContain(secret);
      expect(serialized).not.toContain(secret);
    }
  });

  it("logs nothing when every event resolved", async () => {
    const metrics = new MetricsRegistry();
    const warn_spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const call_count = await count_warnings(warn_spy, () => deliver(metrics, text_value()));
    expect(call_count).toBe(0);
  });
});

/**
 * Count warning lines emitted while one delivery is handled.
 *
 * Captured before the spy is restored, because Vitest clears recorded calls on
 * restore; reading them afterwards would silently assert against an empty log.
 *
 * @param warn_spy - Spy installed on `console.warn`.
 * @param action - Delivery to run while the spy is active.
 * @returns Number of warning calls observed during the delivery.
 */
async function count_warnings(warn_spy: ReturnType<typeof vi.spyOn>, action: () => Promise<void>): Promise<number> {
  try {
    await action();
    return warn_spy.mock.calls.length;
  } finally {
    warn_spy.mockRestore();
  }
}

describe("P0.8 delivery-status callbacks against provider shapes", () => {
  async function claimed_ledger(): Promise<InMemoryOutboundLedgerStore> {
    const ledger = new InMemoryOutboundLedgerStore();
    const claim = await ledger.begin({
      tenant_id: TENANT_ID,
      provider: "whatsapp",
      operation_key: "gate-status-operation",
      request_fingerprint: "a".repeat(64),
    });
    if (claim.kind !== "send") throw new Error("ledger claim setup failed");
    await ledger.mark_sent({
      tenant_id: TENANT_ID,
      provider: "whatsapp",
      operation_key: "gate-status-operation",
      lease_token: claim.lease_token,
      provider_message_id: "wamid.gate.status.1",
    });
    return ledger;
  }

  for (const status of ["sent", "delivered", "read", "failed"] as const) {
    it(`applies a signed ${status} callback monotonically`, async () => {
      const ledger = await claimed_ledger();
      const body = build_status_webhook({ provider_message_id: "wamid.gate.status.1", status });
      const result = await handle_inbound_request(
        body,
        sign_fixture(body, FIXTURE_APP_SECRET),
        FIXTURE_APP_SECRET,
        new InMemoryMessageDedupe(),
        queue_spy(),
        { tenant_resolver: resolver(), outbound_ledger: ledger },
      );
      expect(result.status_count).toBe(1);
      if (status === "sent") {
        expect(result).toMatchObject({ status_updated_count: 0, status_duplicate_count: 1 });
      } else {
        expect(result).toMatchObject({ status_updated_count: 1, status_duplicate_count: 0 });
      }
      expect(ledger.get(TENANT_ID, "whatsapp", "gate-status-operation")?.status).toBe(status);
    });
  }
});

describe("P0.8 service-window behavior against the 24-hour boundary", () => {
  it("stays open just inside 24 hours and closes just outside", () => {
    const now_ms = 1_790_000_000_000;
    expect(is_service_window_open(now_ms - 24 * 60 * 60 * 1000 + 1_000, now_ms)).toBe(true);
    expect(is_service_window_open(now_ms - 24 * 60 * 60 * 1000 - 1_000, now_ms)).toBe(false);
    expect(is_service_window_open(now_ms + 60_000, now_ms)).toBe(false);
  });
});

describe("P0.8 fail-closed approved template gating", () => {
  it("fails closed when no approved template binding is configured", () => {
    expect(() => parse_approved_templates(undefined)).toThrow(ApprovedTemplateConfigError);
    expect(() => parse_approved_templates("")).toThrow(ApprovedTemplateConfigError);
    expect(() => parse_approved_templates("[]")).toThrow(ApprovedTemplateConfigError);
  });

  it("rejects non-utility and promotional bindings", () => {
    expect(() => parse_approved_templates(JSON.stringify([{
      name: "appointment_reminder", language: "en_US", category: "marketing",
    }]))).toThrow(ApprovedTemplateConfigError);
    expect(() => parse_approved_templates(JSON.stringify([{
      name: "promo_blast", language: "en_US", category: "utility",
    }]))).toThrow(ApprovedTemplateConfigError);
    expect(() => parse_approved_templates(JSON.stringify([{
      name: "appointment_reminder", language: "english", category: "utility",
    }]))).toThrow(ApprovedTemplateConfigError);
  });

  it("records approved utility templates and rejects unknown names", () => {
    const templates = parse_approved_templates(JSON.stringify([{
      name: "appointment_reminder", language: "en_US", category: "utility", template_id: "123",
    }]));
    expect(require_approved_template(templates, "appointment_reminder")).toMatchObject({
      name: "appointment_reminder", language: "en_US", category: "utility",
    });
    expect(() => require_approved_template(templates, "slot_offer")).toThrow(ApprovedTemplateConfigError);
  });
});

describe("P0.8 provider error, rate-limit, timeout, and revoked-token mapping", () => {
  it("fences timeouts as ambiguous and retryable", () => {
    expect(classify_provider_error({ code: "request_timeout", timeout: true })).toMatchObject({
      error_code: "provider_timeout", retryable: true, ambiguous: true, credential_revoked: false,
    });
    expect(classify_provider_error({ code: "request_failed", network_failed: true })).toMatchObject({
      ambiguous: true, retryable: true,
    });
  });

  it("maps rate-limit shapes to retryable limits", () => {
    expect(classify_provider_error({ code: "upstream_error", http_status: 429 })).toMatchObject({
      error_code: "provider_rate_limited", retryable: true, ambiguous: false,
    });
    expect(classify_provider_error({ code: "upstream_error", http_status: 400, upstream_code: "131048" })).toMatchObject({
      error_code: "provider_rate_limited", retryable: true,
    });
  });

  it("maps revoked-token shapes to non-retryable credential rotation", () => {
    expect(classify_provider_error({ code: "upstream_error", http_status: 401, upstream_code: "190" })).toMatchObject({
      error_code: "provider_token_revoked", retryable: false, credential_revoked: true,
    });
  });

  it("maps window expiry to template-required and template errors closed", () => {
    expect(classify_provider_error({ code: "upstream_error", http_status: 400, upstream_code: "131047" })).toMatchObject({
      error_code: "service_window_expired", retryable: false, requires_template: true,
    });
    expect(classify_provider_error({ code: "upstream_error", http_status: 400, upstream_code: "132000" })).toMatchObject({
      error_code: "provider_template_rejected", retryable: false,
    });
  });

  it("fails closed on unknown provider shapes", () => {
    expect(classify_provider_error({})).toMatchObject({
      error_code: "provider_request_failed", retryable: false, ambiguous: false,
    });
    expect(classify_sender_code("request_timeout")).toMatchObject({
      error_code: "provider_timeout", retryable: true, ambiguous: true,
    });
    expect(classify_sender_code("upstream_error")).toMatchObject({
      error_code: "provider_unavailable", retryable: true, ambiguous: true,
    });
  });
});

describe("P0.8 staging smoke harness without live credentials", () => {
  it("passes offline provider-shaped checks and reports exact missing access", () => {
    const config = load_staging_smoke_config({});
    const report = run_offline_smoke(config);
    expect(report.environment_ready).toBe(false);
    for (const check of report.checks) {
      if (check.name !== "live_credentials_present" && check.name !== "approved_template_gate") {
        expect(check.status).toBe("pass");
      }
    }
    expect(report.missing).toContain("META_SMOKE_ENVIRONMENT!=staging");
    expect(report.missing).toContain("WHATSAPP_PHONE_NUMBER_ID");
    expect(report.missing).toContain("WHATSAPP_API_TOKEN");
    expect(report.missing).toContain("WHATSAPP_APP_SECRET");
    expect(missing_live_requirements(config)).toEqual(report.missing);
  });

  it("names the exact credential needed for a live template send", () => {
    const config = load_staging_smoke_config({
      META_SMOKE_ENVIRONMENT: "staging",
      META_SMOKE_MODE: "send",
      WHATSAPP_PHONE_NUMBER_ID: "100000000000001",
      WHATSAPP_API_TOKEN: "staging-token",
      WHATSAPP_APP_SECRET: "staging-secret",
    });
    const missing = missing_live_requirements(config);
    expect(missing).toContain("META_SMOKE_ALLOW_SEND!=true");
    expect(missing).toContain("META_SMOKE_RECIPIENT_E164");
    expect(missing).toContain("META_SMOKE_TEMPLATE_NAME");
    expect(missing).toContain(APPROVED_TEMPLATES_ENV);
  });

  it("keeps tokens, recipients, and message content out of the report", () => {
    const token = "staging-token-value-abc123";
    const config = load_staging_smoke_config({
      META_SMOKE_ENVIRONMENT: "staging",
      WHATSAPP_PHONE_NUMBER_ID: "100000000000001",
      WHATSAPP_API_TOKEN: token,
      WHATSAPP_APP_SECRET: "staging-secret",
      META_SMOKE_RECIPIENT_E164: "+15550009999",
    });
    const report = run_offline_smoke(config);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("+15550009999");
    expect(serialized).not.toContain("reschedule my appointment");
  });
});
