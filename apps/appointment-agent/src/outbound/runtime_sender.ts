/** Runtime construction for the tenant-scoped WhatsApp sender boundary. */

import {
  InMemoryTransport,
  MetaGraphTransport,
  WhatsAppSender,
} from "@repo/wa-sender";
import type { OutboundSenderPort, OutboundSenderRegistry } from "../worker/loop.js";
import { mark_multi_tenant_sender_registry, SingleTenantOutboundSenderRegistry } from "./sender_registry.js";
import { TenantSecretSenderRegistry } from "./tenant_sender_registry.js";
import {
  AuditedSecretManager,
  EnvSecretManager,
} from "../security/secret_manager.js";
import type { MetricsSink } from "../observability/metrics.js";
import type { SecretAccessSink } from "../security/secret_manager.js";
import {
  collect_binding_refs,
  parse_tenant_sender_bindings,
  TENANT_SENDER_REFS_ENV,
  TenantSenderCredentialStore,
  type TenantSenderRefs,
} from "../security/tenant_sender_credentials.js";
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

/** Optional audit and metrics dependencies for secret-backed resolution. */
export interface RuntimeSenderDependencies {
  secret_access_sink?: SecretAccessSink;
  metrics?: MetricsSink;
}

/**
 * Build the fail-closed tenant registry used by runtime composition.
 *
 * Database-backed mode resolves sender credentials per tenant through the
 * secret-manager port and fails closed without an explicit tenant mapping;
 * no process-global credential fallback exists on that path. The explicit
 * in-memory local mode keeps the single-sender pilot on tenant `1` unless
 * TENANT_ID overrides it.
 *
 * @param env - Environment mapping; defaults to process.env.
 * @param dependencies - Optional secret audit sink and metrics.
 * @returns A registry bound to the configured runtime tenants.
 * @throws RuntimeSenderConfigurationError for invalid or missing settings.
 */
export function build_runtime_sender(
  env: Record<string, string | undefined> = process.env,
  dependencies: RuntimeSenderDependencies = {},
): OutboundSenderRegistry {
  if (has_database_url(env)) return build_database_sender_registry(env, dependencies);
  const sender = build_sender_adapter(env);
  const tenant_id = resolve_runtime_tenant_id(env, false);
  return new SingleTenantOutboundSenderRegistry(tenant_id, sender);
}

/**
 * Resolve the tenant allowed to use an explicitly injected single sender.
 *
 * This helper serves legacy injected-sender and in-memory paths only. The
 * environment-built database sender no longer uses it: per-tenant secret
 * mappings replace the process-global fallback there.
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

/**
 * Build the per-tenant secret-backed registry for database mode.
 *
 * Unmapped tenants fail closed at send time, so the returned registry is
 * marked multi-tenant: the global claimer is safe because no tenant can
 * reuse another tenant's credentials.
 */
function build_database_sender_registry(
  env: Record<string, string | undefined>,
  dependencies: RuntimeSenderDependencies,
): OutboundSenderRegistry {
  let bindings: Map<string, TenantSenderRefs>;
  try {
    bindings = parse_tenant_sender_bindings(env[TENANT_SENDER_REFS_ENV]);
  } catch {
    throw new RuntimeSenderConfigurationError("tenant-sender-mapping-invalid");
  }
  if (bindings.size === 0) {
    throw new RuntimeSenderConfigurationError("tenant-sender-mapping-required");
  }
  const secret_manager = new AuditedSecretManager(
    new EnvSecretManager(env, collect_binding_refs(bindings)),
    dependencies.secret_access_sink,
    dependencies.metrics,
  );
  const credential_store = new TenantSenderCredentialStore(secret_manager, bindings, {
    sink: dependencies.secret_access_sink,
    metrics: dependencies.metrics,
  });
  const graph_api_url = env["WHATSAPP_GRAPH_API_URL"] ?? DEFAULT_WHATSAPP_GRAPH_API_URL;
  const request_timeout_ms = parse_positive_integer(env["WHATSAPP_REQUEST_TIMEOUT_MS"] ?? "10000");
  return mark_multi_tenant_sender_registry(
    new TenantSecretSenderRegistry({
      credential_store,
      graph_api_url,
      request_timeout_ms,
    }),
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
