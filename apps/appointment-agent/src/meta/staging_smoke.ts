/** Offline-capable smoke harness for the Meta staging integration gate. */

import { is_service_window_open, SERVICE_WINDOW_MS } from "../agent_types.js";
import { is_valid_signature } from "../ingress/verify.js";
import { extract_outbound_statuses } from "../outbound/status_events.js";
import { parse_inbound_messages } from "../webhook_handler.js";
import { APPROVED_TEMPLATES_ENV, parse_approved_templates } from "./approved_templates.js";
import { classify_provider_error } from "./provider_error_map.js";
import {
  build_handoff_webhook,
  build_interactive_reply_webhook,
  build_legacy_button_webhook,
  build_status_webhook,
  build_text_webhook,
  FIXTURE_APP_SECRET,
  FIXTURE_PHONE_NUMBER_ID,
  sign_fixture,
} from "./provider_fixtures.js";

/** Staging smoke settings; tokens are presence flags only, never values. */
export interface StagingSmokeConfig {
  environment?: string;
  graph_api_url?: string;
  phone_number_id?: string;
  access_token_present: boolean;
  app_secret_present: boolean;
  allow_send: boolean;
  recipient_present: boolean;
  template_name?: string;
  template_language?: string;
  approved_templates_json?: string;
  template_send_requested: boolean;
}

/** One harness check outcome; detail carries safe metadata only. */
export interface SmokeCheckResult {
  name: string;
  status: "pass" | "blocked" | "fail";
  detail: string;
}

/** Offline harness report with exact missing live requirements. */
export interface StagingSmokeReport {
  environment_ready: boolean;
  checks: SmokeCheckResult[];
  missing: string[];
}

/**
 * Load smoke settings without retaining credential values.
 *
 * Only presence flags are recorded so the report can never leak a token,
 * a recipient number, or message content.
 *
 * @param env - Environment mapping; defaults to the process environment.
 * @returns Presence-only smoke configuration.
 */
export function load_staging_smoke_config(
  env: Record<string, string | undefined> = process.env,
): StagingSmokeConfig {
  return {
    environment: env["META_SMOKE_ENVIRONMENT"],
    graph_api_url: env["META_SMOKE_GRAPH_API_URL"] ?? "https://graph.facebook.com/v23.0",
    phone_number_id: env["WHATSAPP_PHONE_NUMBER_ID"],
    access_token_present: is_set(env["WHATSAPP_API_TOKEN"]),
    app_secret_present: is_set(env["WHATSAPP_APP_SECRET"]),
    allow_send: env["META_SMOKE_ALLOW_SEND"] === "true",
    recipient_present: is_set(env["META_SMOKE_RECIPIENT_E164"]),
    template_name: env["META_SMOKE_TEMPLATE_NAME"],
    template_language: env["META_SMOKE_TEMPLATE_LANGUAGE"] ?? "en_US",
    approved_templates_json: env[APPROVED_TEMPLATES_ENV],
    template_send_requested: (env["META_SMOKE_MODE"] ?? "preflight") === "send",
  };
}

/**
 * List exact credentials and access missing for a live staging run.
 *
 * @param config - Presence-only smoke configuration.
 * @returns Missing environment names or staging requirements.
 */
export function missing_live_requirements(config: StagingSmokeConfig): string[] {
  const missing: string[] = [];
  if (config.environment !== "staging") missing.push("META_SMOKE_ENVIRONMENT!=staging");
  if (config.phone_number_id === undefined || config.phone_number_id === "") {
    missing.push("WHATSAPP_PHONE_NUMBER_ID");
  }
  if (!config.access_token_present) missing.push("WHATSAPP_API_TOKEN");
  if (!config.app_secret_present) missing.push("WHATSAPP_APP_SECRET");
  if (config.template_send_requested) {
    if (!config.allow_send) missing.push("META_SMOKE_ALLOW_SEND!=true");
    if (!config.recipient_present) missing.push("META_SMOKE_RECIPIENT_E164");
    if (config.template_name === undefined || config.template_name === "") {
      missing.push("META_SMOKE_TEMPLATE_NAME");
    }
    missing.push(...missing_template_config(config));
  }
  return missing;
}

/**
 * Run the deterministic offline gate checks without network I/O.
 *
 * Live credential presence only gates the environment_ready flag and the
 * credential check; every provider-shaped check runs offline against
 * fixtures so the gate is executable before credentials land.
 *
 * @param config - Presence-only smoke configuration.
 * @returns Offline report with per-check outcomes and missing live items.
 */
export function run_offline_smoke(config: StagingSmokeConfig): StagingSmokeReport {
  const checks: SmokeCheckResult[] = [
    check_signature_accepts_live_shaped_payload(),
    check_signature_rejects_tampered_payload(),
    check_inbound_text_button_handoff_fixtures(),
    check_duplicate_payload_carries_stable_identity(),
    check_status_callbacks_parse(),
    check_service_window_boundaries(),
    check_template_gate(config),
    check_error_classification(),
  ];
  const missing = missing_live_requirements({ ...config, template_send_requested: false });
  const credential_check = check_live_credentials(missing);
  return {
    environment_ready: missing.length === 0,
    checks: [...checks, credential_check],
    missing,
  };
}

function missing_template_config(config: StagingSmokeConfig): string[] {
  try {
    parse_approved_templates(config.approved_templates_json);
    return [];
  } catch {
    return [APPROVED_TEMPLATES_ENV];
  }
}

function check_signature_accepts_live_shaped_payload(): SmokeCheckResult {
  const body = build_text_webhook();
  const valid = is_valid_signature(body, sign_fixture(body, FIXTURE_APP_SECRET), FIXTURE_APP_SECRET);
  return valid
    ? { name: "webhook_signature_accepts", status: "pass", detail: "signed-text-fixture-verified" }
    : { name: "webhook_signature_accepts", status: "fail", detail: "signed-text-fixture-rejected" };
}

function check_signature_rejects_tampered_payload(): SmokeCheckResult {
  const body = build_text_webhook();
  const tampered = `${body} `;
  const accepted = is_valid_signature(tampered, sign_fixture(body, FIXTURE_APP_SECRET), FIXTURE_APP_SECRET);
  return accepted
    ? { name: "webhook_signature_rejects_tampered", status: "fail", detail: "tampered-fixture-accepted" }
    : { name: "webhook_signature_rejects_tampered", status: "pass", detail: "tampered-fixture-rejected" };
}

function check_inbound_text_button_handoff_fixtures(): SmokeCheckResult {
  try {
    const text = parse_inbound_messages(build_text_webhook({ wamid: "wamid.smoke.text" }));
    const legacy = parse_inbound_messages(build_legacy_button_webhook({ wamid: "wamid.smoke.legacy" }));
    const interactive = parse_inbound_messages(build_interactive_reply_webhook({ wamid: "wamid.smoke.interactive" }));
    const handoff = parse_inbound_messages(build_handoff_webhook({ wamid: "wamid.smoke.handoff" }));
    const kinds = [
      text[0]?.message_kind,
      legacy[0]?.message_kind,
      interactive[0]?.message_kind,
      handoff[0]?.message_kind,
    ];
    const ok = kinds[0] === "text" && kinds[1] === "button_reply" && kinds[2] === "button_reply" && kinds[3] === "text"
      && (handoff[0]?.text_body ?? "").toLowerCase().includes("operator");
    return ok
      ? { name: "inbound_text_button_handoff", status: "pass", detail: "text-button-interactive-handoff-parsed" }
      : { name: "inbound_text_button_handoff", status: "fail", detail: "fixture-kind-mismatch" };
  } catch {
    return { name: "inbound_text_button_handoff", status: "fail", detail: "fixture-parse-failed" };
  }
}

function check_duplicate_payload_carries_stable_identity(): SmokeCheckResult {
  try {
    const body = build_text_webhook({ wamid: "wamid.smoke.duplicate" });
    const first = parse_inbound_messages(body)[0]?.wamid;
    const second = parse_inbound_messages(body)[0]?.wamid;
    return first !== undefined && first === second
      ? { name: "duplicate_payload_stable_identity", status: "pass", detail: "duplicate-wamid-stable" }
      : { name: "duplicate_payload_stable_identity", status: "fail", detail: "duplicate-wamid-unstable" };
  } catch {
    return { name: "duplicate_payload_stable_identity", status: "fail", detail: "fixture-parse-failed" };
  }
}

function check_status_callbacks_parse(): SmokeCheckResult {
  try {
    const events: string[] = [];
    for (const status of ["sent", "delivered", "read", "failed"] as const) {
      const parsed = extract_outbound_statuses(JSON.parse(build_status_webhook({
        provider_message_id: "wamid.smoke.status.1",
        status,
      })));
      const event = parsed[0];
      if (event === undefined || event.channel_account_id !== FIXTURE_PHONE_NUMBER_ID) {
        return { name: "status_callbacks_parse", status: "fail", detail: "status-channel-mismatch" };
      }
      events.push(event.event.status);
    }
    const ok = events.join(",") === "sent,delivered,read,failed";
    return ok
      ? { name: "status_callbacks_parse", status: "pass", detail: "sent-delivered-read-failed-parsed" }
      : { name: "status_callbacks_parse", status: "fail", detail: "status-sequence-mismatch" };
  } catch {
    return { name: "status_callbacks_parse", status: "fail", detail: "status-parse-failed" };
  }
}

function check_service_window_boundaries(): SmokeCheckResult {
  const now_ms = 1_790_000_000_000;
  const just_inside = is_service_window_open(now_ms - SERVICE_WINDOW_MS + 1_000, now_ms);
  const just_outside = is_service_window_open(now_ms - SERVICE_WINDOW_MS - 1_000, now_ms);
  const future = is_service_window_open(now_ms + 60_000, now_ms);
  return just_inside && !just_outside && !future
    ? { name: "service_window_boundaries", status: "pass", detail: "window-open-inside-closed-outside" }
    : { name: "service_window_boundaries", status: "fail", detail: "window-boundary-mismatch" };
}

function check_template_gate(config: StagingSmokeConfig): SmokeCheckResult {
  try {
    const templates = parse_approved_templates(config.approved_templates_json);
    return {
      name: "approved_template_gate",
      status: "pass",
      detail: `approved-templates-configured:${templates.length}`,
    };
  } catch {
    return {
      name: "approved_template_gate",
      status: "blocked",
      detail: `approved-template-missing:${APPROVED_TEMPLATES_ENV}`,
    };
  }
}

function check_error_classification(): SmokeCheckResult {
  const timeout = classify_provider_error({ code: "request_timeout", timeout: true });
  const limited = classify_provider_error({ code: "upstream_error", http_status: 429 });
  const revoked = classify_provider_error({ code: "upstream_error", http_status: 401, upstream_code: "190" });
  const window = classify_provider_error({ code: "upstream_error", http_status: 400, upstream_code: "131047" });
  const template = classify_provider_error({ code: "upstream_error", http_status: 400, upstream_code: "132000" });
  const ok = timeout.ambiguous && timeout.retryable
    && limited.retryable && limited.error_code === "provider_rate_limited"
    && revoked.credential_revoked && !revoked.retryable
    && window.requires_template && !window.retryable
    && template.error_code === "provider_template_rejected";
  return ok
    ? { name: "provider_error_classification", status: "pass", detail: "timeout-limit-revoked-window-template-mapped" }
    : { name: "provider_error_classification", status: "fail", detail: "error-mapping-mismatch" };
}

function check_live_credentials(missing: string[]): SmokeCheckResult {
  return missing.length === 0
    ? { name: "live_credentials_present", status: "pass", detail: "staging-credentials-present" }
    : { name: "live_credentials_present", status: "blocked", detail: `live-credentials-missing:${missing.length}` };
}

function is_set(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}
