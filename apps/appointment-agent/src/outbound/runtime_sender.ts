/** Runtime construction for the tenant-scoped WhatsApp sender boundary. */

import {
  InMemoryTransport,
  MetaGraphTransport,
  WhatsAppSender,
} from "@repo/wa-sender";
import type { OutboundSenderPort, OutboundSenderRegistry } from "../worker/loop.js";
import { SingleTenantOutboundSenderRegistry } from "./sender_registry.js";
import { WhatsAppSenderAdapter } from "./whatsapp_sender_adapter.js";

/** Safe failure when outbound transport configuration is incomplete. */
export class RuntimeSenderConfigurationError extends Error {
  /** Create a sanitized configuration error. */
  constructor(reason: string) {
    super(`runtime-sender-configuration-invalid: ${reason}`);
    this.name = "RuntimeSenderConfigurationError";
  }
}

/** Default tenant used only by the explicit in-memory local pilot. */
export const DEFAULT_IN_MEMORY_TENANT_ID = "1";

/** Default Graph API base URL; deployments should pin a verified version. */
export const DEFAULT_WHATSAPP_GRAPH_API_URL = "https://graph.facebook.com/v23.0";

/**
 * Build the fail-closed tenant registry used by runtime composition.
 *
 * Database-backed mode requires TENANT_ID. The in-memory local mode uses tenant
 * `1` when TENANT_ID is absent, preserving the existing one-sender pilot without
 * permitting another tenant to reuse it.
 *
 * @param env - Environment mapping; defaults to process.env.
 * @returns A registry bound to the configured runtime tenant.
 * @throws RuntimeSenderConfigurationError for invalid or missing settings.
 */
export function build_runtime_sender(
  env: Record<string, string | undefined> = process.env,
): OutboundSenderRegistry {
  const sender = build_sender_adapter(env);
  const tenant_id = resolve_runtime_tenant_id(env, has_database_url(env));
  return new SingleTenantOutboundSenderRegistry(tenant_id, sender);
}

/**
 * Resolve the tenant allowed to use the environment-built sender.
 *
 * @param env - Environment mapping.
 * @param is_database_backed - Whether the composition uses persistent storage.
 * @returns The explicit database tenant or the local in-memory default.
 * @throws RuntimeSenderConfigurationError when a database binding is absent.
 */
export function resolve_runtime_tenant_id(
  env: Record<string, string | undefined>,
  is_database_backed: boolean,
): string {
  if (is_database_backed) return required_setting(env, "TENANT_ID").trim();
  const configured = env["TENANT_ID"]?.trim();
  return configured === undefined || configured === ""
    ? DEFAULT_IN_MEMORY_TENANT_ID
    : configured;
}

function build_sender_adapter(env: Record<string, string | undefined>): OutboundSenderPort {
  if (env["USE_IN_MEMORY"] === "true" && has_database_url(env)) {
    throw new RuntimeSenderConfigurationError("database-and-in-memory-mode-are-mutually-exclusive");
  }
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

function has_database_url(env: Record<string, string | undefined>): boolean {
  const value = env["DATABASE_URL"];
  return typeof value === "string" && value.trim() !== "";
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
