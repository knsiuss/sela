/** Per-tenant Meta sender credential resolution with emergency revocation. */

import {
  SecretManagerError,
  record_secret_access,
  require_ref,
  type SecretManager,
  type SecretAccessSink,
} from "./secret_manager.js";
import type { MetricsSink } from "../observability/metrics.js";

/** Environment variable carrying the tenant-to-secret-ref mapping JSON. */
export const TENANT_SENDER_REFS_ENV = "WHATSAPP_TENANT_SENDER_REFS_JSON";

const MAX_BINDINGS_JSON_CHARS = 32_768;
const MAX_TENANT_BINDINGS = 100;
const MAX_TENANT_ID_CHARS = 256;

/** Secret references for one tenant's Meta sender credentials. */
export interface TenantSenderRefs {
  phone_number_id_ref: string;
  access_token_ref: string;
}

/** Resolved sender credentials for immediate transport use only. */
export interface TenantSenderCredentials {
  phone_number_id: string;
  access_token: string;
}

/** Options for credential resolution audit and clock injection. */
export interface TenantCredentialStoreOptions {
  sink?: SecretAccessSink;
  metrics?: MetricsSink;
  clock?: () => Date;
}

/**
 * Resolve per-tenant sender credentials through a SecretManager.
 *
 * Credential values are resolved at send time and never persisted; only the
 * reference mapping is retained. Revocation is deliberately sticky for the
 * process lifetime so a revoked tenant fails closed until restart/redeploy.
 */
export class TenantSenderCredentialStore {
  private readonly secret_manager: SecretManager;
  private readonly bindings: Map<string, TenantSenderRefs>;
  private readonly revoked = new Set<string>();
  private readonly sink: SecretAccessSink | undefined;
  private readonly metrics: MetricsSink | undefined;
  private readonly clock: () => Date;

  /**
   * Create the store from an already-validated tenant binding map.
   *
   * @param secret_manager - Audited secret resolution port.
   * @param bindings - Tenant id to secret-reference mapping.
   * @param options - Optional audit sink, metrics, and clock.
   */
  constructor(
    secret_manager: SecretManager,
    bindings: ReadonlyMap<string, TenantSenderRefs>,
    options: TenantCredentialStoreOptions = {},
  ) {
    this.secret_manager = secret_manager;
    this.bindings = new Map<string, TenantSenderRefs>();
    for (const [tenant_id, refs] of bindings) {
      this.bindings.set(require_tenant_id(tenant_id), {
        phone_number_id_ref: require_ref(refs.phone_number_id_ref),
        access_token_ref: require_ref(refs.access_token_ref),
      });
    }
    this.sink = options.sink;
    this.metrics = options.metrics;
    this.clock = options.clock ?? (() => new Date());
  }

  /**
   * List configured tenant ids in stable order.
   *
   * @returns Sorted tenant ids with a credential binding.
   */
  configured_tenants(): string[] {
    return [...this.bindings.keys()].sort();
  }

  /**
   * Check whether a tenant was emergency-revoked.
   *
   * @param tenant_id - Tenant carried by the claimed job.
   * @returns True after a successful revoke call.
   */
  is_revoked(tenant_id: string): boolean {
    return this.revoked.has(tenant_id);
  }

  /**
   * Resolve one tenant's sender credentials for immediate transport use.
   *
   * @param tenant_id - Tenant carried by the claimed job.
   * @returns Credentials that must not be logged or persisted.
   * @throws SecretManagerError for revoked, unmapped, or unconfigured tenants.
   */
  resolve(tenant_id: string): TenantSenderCredentials {
    const tenant = require_tenant_id(tenant_id);
    if (this.revoked.has(tenant)) {
      this.audit(tenant, "revoked");
      throw new SecretManagerError("secret-revoked");
    }
    const refs = this.bindings.get(tenant);
    if (refs === undefined) {
      this.audit(tenant, "miss");
      throw new SecretManagerError("secret-not-configured");
    }
    let credentials: TenantSenderCredentials;
    try {
      credentials = {
        phone_number_id: this.secret_manager.get_secret(refs.phone_number_id_ref),
        access_token: this.secret_manager.get_secret(refs.access_token_ref),
      };
    } catch (error) {
      this.audit(tenant, "miss");
      if (error instanceof SecretManagerError) throw error;
      throw new SecretManagerError("secret-not-configured");
    }
    this.audit(tenant, "hit");
    return credentials;
  }

  /**
   * Emergency-revoke one tenant's credentials for this process lifetime.
   *
   * @param tenant_id - Tenant to revoke.
   */
  revoke(tenant_id: string): void {
    const tenant = require_tenant_id(tenant_id);
    this.revoked.add(tenant);
    record_secret_access(this.sink, this.metrics, {
      secret_ref: "tenant-sender-credentials",
      tenant_id: tenant,
      operation: "revoke",
      result: "revoked",
      at: this.clock().toISOString(),
    });
  }

  /** Audit one resolution outcome without secret values. */
  private audit(tenant_id: string, result: "hit" | "miss" | "revoked"): void {
    record_secret_access(this.sink, this.metrics, {
      secret_ref: "tenant-sender-credentials",
      tenant_id,
      operation: "read",
      result,
      at: this.clock().toISOString(),
    });
  }
}

/**
 * Parse the tenant-to-secret-ref mapping from environment JSON.
 *
 * Expected shape: `{"<tenant_id>": {"phone_number_id_ref": "...",
 * "access_token_ref": "..."}}`. An absent or blank value yields an empty map
 * so callers fail closed on size rather than on parse.
 *
 * @param raw - Raw JSON text from WHATSAPP_TENANT_SENDER_REFS_JSON.
 * @returns Validated tenant binding map.
 * @throws SecretManagerError when the JSON or binding shape is invalid.
 */
export function parse_tenant_sender_bindings(raw: string | undefined): Map<string, TenantSenderRefs> {
  if (raw === undefined || raw.trim() === "") return new Map();
  if (raw.length > MAX_BINDINGS_JSON_CHARS) throw new SecretManagerError("secret-mapping-invalid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SecretManagerError("secret-mapping-invalid");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SecretManagerError("secret-mapping-invalid");
  }
  const bindings = new Map<string, TenantSenderRefs>();
  for (const [tenant_id, refs] of Object.entries(parsed)) {
    if (bindings.size >= MAX_TENANT_BINDINGS) throw new SecretManagerError("secret-mapping-invalid");
    bindings.set(require_tenant_id(tenant_id), {
      phone_number_id_ref: require_ref((refs as TenantSenderRefs)?.phone_number_id_ref),
      access_token_ref: require_ref((refs as TenantSenderRefs)?.access_token_ref),
    });
  }
  return bindings;
}

/**
 * Collect every secret reference in a binding map for allow-listing.
 *
 * @param bindings - Validated tenant binding map.
 * @returns Exact reference names the env adapter may resolve.
 */
export function collect_binding_refs(bindings: ReadonlyMap<string, TenantSenderRefs>): Set<string> {
  const refs = new Set<string>();
  for (const entry of bindings.values()) {
    refs.add(entry.phone_number_id_ref);
    refs.add(entry.access_token_ref);
  }
  return refs;
}

/**
 * Validate a tenant id without normalizing it.
 *
 * @param tenant_id - Untrusted tenant input.
 * @returns The validated tenant id.
 * @throws SecretManagerError when the format is invalid.
 */
export function require_tenant_id(tenant_id: string): string {
  if (
    typeof tenant_id !== "string" ||
    tenant_id.trim() === "" ||
    tenant_id.length > MAX_TENANT_ID_CHARS ||
    tenant_id.trim() !== tenant_id
  ) {
    throw new SecretManagerError("secret-ref-invalid");
  }
  return tenant_id;
}
