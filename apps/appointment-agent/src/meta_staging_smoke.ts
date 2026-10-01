/** Explicit, opt-in Meta staging smoke test; never sends without a hard allow flag. */

import { createHmac } from "node:crypto";

const mode = process.env["META_SMOKE_MODE"] ?? "preflight";
const environment = process.env["META_SMOKE_ENVIRONMENT"];
const graph_api_url = process.env["META_SMOKE_GRAPH_API_URL"] ?? "https://graph.facebook.com/v23.0";
const phone_number_id = process.env["WHATSAPP_PHONE_NUMBER_ID"];
const access_token = process.env["WHATSAPP_API_TOKEN"];
const app_secret = process.env["WHATSAPP_APP_SECRET"];

if (environment !== "staging") {
  blocked("META_SMOKE_ENVIRONMENT-staging-required");
} else if (phone_number_id === undefined || access_token === undefined) {
  blocked("WHATSAPP_STAGING_CREDENTIALS-required");
} else if (!safe_graph_url(graph_api_url)) {
  blocked("META_SMOKE_GRAPH_API_URL-invalid");
} else if (mode === "preflight") {
  await run_preflight();
} else if (mode === "send") {
  await run_send();
} else {
  blocked("META_SMOKE_MODE-invalid");
}

async function run_preflight(): Promise<void> {
  const response = await request(`/${encodeURIComponent(phone_number_id!)}?fields=throughput,quality_rating`);
  if (!response.ok) {
    console.error(JSON.stringify({ event: "meta_staging_smoke_failed", stage: "phone_preflight", status: response.status }));
    process.exitCode = 1;
    return;
  }
  const payload: unknown = await response.json();
  const record = is_record(payload) ? payload : {};
  console.log(JSON.stringify({
    event: "meta_staging_smoke_completed",
    mode: "preflight",
    graph_host: new URL(graph_api_url).hostname,
    phone_number_id_present: true,
    throughput_present: typeof record.throughput === "object" && record.throughput !== null,
    quality_rating_present: typeof record.quality_rating === "string",
    signature_fixture: app_secret === undefined ? "skipped" : signature_fixture(),
  }));
}

async function run_send(): Promise<void> {
  if (process.env["META_SMOKE_ALLOW_SEND"] !== "true") {
    blocked("META_SMOKE_ALLOW_SEND-required");
    return;
  }
  const recipient = process.env["META_SMOKE_RECIPIENT_E164"];
  const template_name = process.env["META_SMOKE_TEMPLATE_NAME"];
  const language = process.env["META_SMOKE_TEMPLATE_LANGUAGE"] ?? "en_US";
  if (!valid_recipient(recipient) || template_name === undefined || !/^[A-Za-z0-9_]{1,128}$/.test(template_name)) {
    blocked("META_SMOKE_TEMPLATE_TARGET-invalid");
    return;
  }
  const response = await request(`/${encodeURIComponent(phone_number_id!)}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: recipient,
      type: "template",
      template: { name: template_name, language: { code: language } },
    }),
  });
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok || !is_record(payload) || !Array.isArray(payload.messages)) {
    console.error(JSON.stringify({ event: "meta_staging_smoke_failed", stage: "template_send", status: response.status }));
    process.exitCode = 1;
    return;
  }
  const first = payload.messages[0];
  const wamid = is_record(first) && typeof first.id === "string" ? first.id : null;
  console.log(JSON.stringify({
    event: "meta_staging_smoke_completed",
    mode: "send",
    graph_host: new URL(graph_api_url).hostname,
    provider_message_id_present: wamid !== null,
    provider_message_id: wamid,
  }));
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const endpoint = new URL(`${graph_api_url.replace(/\/$/u, "")}${path}`);
  return fetch(endpoint, {
    ...init,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${access_token}`,
      ...(init.headers ?? {}),
    },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
}

function safe_graph_url(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:"
      && parsed.hostname === "graph.facebook.com"
      && parsed.username === ""
      && parsed.password === ""
      && parsed.search === ""
      && parsed.hash === ""
      && (parsed.port === "" || parsed.port === "443");
  } catch {
    return false;
  }
}

function valid_recipient(value: string | undefined): value is string {
  return value !== undefined && /^\+[1-9]\d{7,14}$/.test(value);
}

function signature_fixture(): string {
  const body = JSON.stringify({ object: "whatsapp_business_account", fixture: true });
  return `sha256=${createHmac("sha256", app_secret!).update(body).digest("hex")}`;
}

function blocked(reason: string): void {
  console.error(JSON.stringify({ event: "meta_staging_smoke_blocked", reason }));
  process.exitCode = 2;
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
