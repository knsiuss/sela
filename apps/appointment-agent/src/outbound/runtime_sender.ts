/** Runtime construction for the tenant-scoped WhatsApp sender boundary. */

import {
  InMemoryTransport,
  MetaGraphTransport,
  WhatsAppSender,
} from "@repo/wa-sender";
import type { OutboundSenderPort } from "../worker/loop.js";
import { WhatsAppSenderAdapter } from "./whatsapp_sender_adapter.js";

/** Safe failure when outbound transport configuration is incomplete. */
export class RuntimeSenderConfigurationError extends Error {
  /** Create a sanitized configuration error. */
  constructor(reason: string) {
    super(`runtime-sender-configuration-invalid: ${reason}`);
    this.name = "RuntimeSenderConfigurationError";
  }
}

/** Default Graph API base URL; deployments should pin a verified version. */
export const DEFAULT_WHATSAPP_GRAPH_API_URL = "https://graph.facebook.com/v23.0";

/**
 * Build the process sender from environment configuration.
 *
 * Explicit in-memory mode defaults to a non-network transport. Database-backed
 * or explicitly selected Meta mode requires a tenant-scoped phone number id and
 * access token supplied by the deployment secret manager.
 *
 * @param env - Environment mapping; defaults to process.env.
 * @returns An adapter implementing the worker's sender port.
 * @throws RuntimeSenderConfigurationError for invalid or missing settings.
 */
export function build_runtime_sender(
  env: Record<string, string | undefined> = process.env,
): OutboundSenderPort {
  const configured_mode = env["WHATSAPP_TRANSPORT"]?.trim();
  const mode = configured_mode === undefined || configured_mode === ""
    ? (env["USE_IN_MEMORY"] === "true" ? "memory" : "meta")
    : configured_mode;
  if (mode === "memory") {
    if (env["USE_IN_MEMORY"] !== "true") {
      throw new RuntimeSenderConfigurationError("memory-transport-requires-in-memory-mode");
    }
    return new WhatsAppSenderAdapter(new WhatsAppSender(new InMemoryTransport()));
  }
  if (mode !== "meta") throw new RuntimeSenderConfigurationError("transport-invalid");
  const phone_number_id = required_setting(env, "WHATSAPP_PHONE_NUMBER_ID");
  const access_token = required_setting(env, "WHATSAPP_API_TOKEN");
  const graph_api_url = env["WHATSAPP_GRAPH_API_URL"] ?? DEFAULT_WHATSAPP_GRAPH_API_URL;
  const request_timeout_ms = parse_positive_integer(env["WHATSAPP_REQUEST_TIMEOUT_MS"] ?? "10000");
  return new WhatsAppSenderAdapter(
    new WhatsAppSender(
      new MetaGraphTransport({
        graph_api_url,
        phone_number_id,
        access_token,
        request_timeout_ms,
      }),
    ),
  );
}

function required_setting(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new RuntimeSenderConfigurationError(`${name}-required`);
  }
  return value;
}

function parse_positive_integer(value: string): number {
  if (!/^\d+$/.test(value)) throw new RuntimeSenderConfigurationError("timeout-invalid");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 120_000) {
    throw new RuntimeSenderConfigurationError("timeout-invalid");
  }
  return parsed;
}
