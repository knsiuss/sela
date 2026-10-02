/**
 * Signed delivery of one webhook body to the real agent ingress.
 *
 * The signature is produced by the agent's own `compute_signature_hex` over
 * the exact bytes that go on the wire, and the app secret stays inside this
 * server-side module: nothing here returns, logs, or serialises it. The
 * browser only ever sees a status, a bounded error token, and the ingress
 * counters the agent itself returned.
 */

import { compute_signature_hex, SIGNATURE_PREFIX } from "appointment-agent/dist/src/ingress/verify.js";

/** Header Meta uses for the HMAC-SHA256 body digest. */
export const SIGNATURE_HEADER = "x-hub-signature-256";

/** Only a known ingress error token may cross back to the browser. */
const SAFE_ERROR_CODE = /^[a-z_]{1,32}$/u;

/** A request id from the agent is a UUID. */
const SAFE_REQUEST_ID = /^[0-9a-f-]{1,64}$/u;

/** Options for the fetch implementation the delivery uses. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Ingress counters the agent returns for one delivery. */
export interface IngressCounts {
  request_id: string;
  received_count: number;
  enqueued_count: number;
  duplicate_count: number;
  unresolved_count: number;
  status_count: number;
}

/** Result of one signed POST, reduced to values that are safe to display. */
export interface SignedDeliveryResult {
  http_status: number;
  error?: string;
  ingress?: IngressCounts;
}

/** Immutable settings for one delivery target. */
export interface SignedDeliveryConfig {
  agent_base_url: string;
  webhook_path: string;
  app_secret: string;
  fetch?: FetchLike;
  timeout_ms?: number;
}

/** Dev-only self-check that proves the ingress rejects a bad signature. */
export interface TamperSelfCheck {
  enabled: boolean;
}

/** Default upper bound on the ingress round trip. */
const DEFAULT_TIMEOUT_MS = 5_000;

/** Sanitized failure for a delivery this tool cannot perform. */
export class SignedDeliveryError extends Error {
  /** Create a safe delivery failure. */
  constructor(reason: string) {
    super(`signed-delivery-failed: ${reason}`);
    this.name = "SignedDeliveryError";
  }
}

/**
 * POST one raw webhook body to the agent with a genuine Meta signature.
 *
 * @param config - Target, path, app secret, and optional fetch/timeout.
 * @param raw_body - Exact bytes to sign and send.
 * @param tamper - Optional self-check override, dev use only.
 * @returns Observed HTTP status, a bounded error token, and ingress counters.
 * @throws SignedDeliveryError When the request cannot be completed.
 */
export async function post_signed_delivery(
  config: SignedDeliveryConfig,
  raw_body: string,
  tamper: TamperSelfCheck = { enabled: false },
): Promise<SignedDeliveryResult> {
  if (config.app_secret === "") throw new SignedDeliveryError("app-secret-missing");
  const fetch_impl = config.fetch ?? globalThis.fetch;
  if (typeof fetch_impl !== "function") throw new SignedDeliveryError("fetch-unavailable");
  const signature = tamper.enabled
    ? `${SIGNATURE_PREFIX}${"0".repeat(64)}`
    : `${SIGNATURE_PREFIX}${compute_signature_hex(raw_body, config.app_secret)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeout_ms ?? DEFAULT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch_impl(`${config.agent_base_url}${config.webhook_path}`, {
      method: "POST",
      headers: { "content-type": "application/json", [SIGNATURE_HEADER]: signature },
      body: raw_body,
      signal: controller.signal,
    });
  } catch {
    throw new SignedDeliveryError("agent-unreachable");
  } finally {
    clearTimeout(timer);
  }
  const body = await read_json(response);
  if (response.status !== 200) {
    return { http_status: response.status, ...bounded_error(body) };
  }
  return { http_status: response.status, ...bounded_ingress(body) };
}

async function read_json(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/**
 * Reduce an error response to a known ingress token.
 *
 * @param body - Parsed upstream body.
 * @returns The bounded token when one is recognisable.
 */
function bounded_error(body: unknown): { error?: string } {
  if (typeof body !== "object" || body === null) return {};
  const value = (body as { error?: unknown }).error;
  return typeof value === "string" && SAFE_ERROR_CODE.test(value) ? { error: value } : {};
}

/**
 * Reduce a success response to the counters the agent documents.
 *
 * Re-checking the shape here means a future upstream change cannot widen what
 * this bridge relays into the browser.
 *
 * @param body - Parsed upstream body.
 * @returns Counters, or an empty object when they are not as expected.
 */
function bounded_ingress(body: unknown): { ingress?: IngressCounts } {
  if (typeof body !== "object" || body === null) return {};
  const record = body as Record<string, unknown>;
  const request_id = record["request_id"];
  const counters = {
    received_count: bounded_count(record["received_count"]),
    enqueued_count: bounded_count(record["enqueued_count"]),
    duplicate_count: bounded_count(record["duplicate_count"]),
    unresolved_count: bounded_count(record["unresolved_count"]),
    status_count: bounded_count(record["status_count"]),
  };
  if (typeof request_id !== "string" || !SAFE_REQUEST_ID.test(request_id)) return {};
  if (Object.values(counters).some((value) => value === undefined)) return {};
  return { ingress: { request_id, ...counters } as IngressCounts };
}

function bounded_count(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 1_000_000
    ? (value as number)
    : undefined;
}
