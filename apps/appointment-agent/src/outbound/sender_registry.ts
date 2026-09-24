/** Tenant-aware selection of the per-sender outbound boundary. */

import type {
  OutboundSenderPort,
  OutboundSenderRegistry,
} from "../worker/loop.js";
import type { OutboundDraft } from "../worker/process_job.js";

export type { OutboundSenderRegistry } from "../worker/loop.js";

/** Runtime marker for an explicitly declared all-tenant sender registry. */
export const MULTI_TENANT_SENDER_REGISTRY = Symbol("multi-tenant-sender-registry");

/** Explicit deployment contract required before the worker may use the global claimer. */
export interface MultiTenantOutboundSenderRegistry extends OutboundSenderRegistry {
  readonly [MULTI_TENANT_SENDER_REGISTRY]: true;
  readonly tenant_coverage: "all_tenants";
}

/** Sanitized failure when a tenant has no configured outbound sender. */
export class OutboundSenderRegistryError extends Error {
  /** Stable code persisted by the worker without exposing tenant or provider data. */
  readonly code = "tenant_sender_not_configured";

  /** Create a safe registry configuration or lookup error. */
  constructor(
    reason: "tenant-not-configured" | "registry-invalid" | "sender-reuse" = "tenant-not-configured",
  ) {
    super(`outbound-sender-registry-invalid: ${reason}`);
    this.name = "OutboundSenderRegistryError";
  }
}

/** Bind one configured sender to exactly one tenant for a single-tenant pilot. */
export class SingleTenantOutboundSenderRegistry implements OutboundSenderRegistry {
  private readonly tenant_id: string;
  private readonly sender: OutboundSenderPort;

  /**
   * Create a single-tenant registry.
   *
   * @param tenant_id - The only tenant allowed to use the sender.
   * @param sender - Configured per-tenant sender adapter.
   */
  constructor(tenant_id: string, sender: OutboundSenderPort) {
    this.tenant_id = require_tenant_id(tenant_id);
    this.sender = require_sender(sender);
  }

  /**
   * Select and send through the bound sender.
   *
   * @param tenant_id - Tenant carried by the claimed job.
   * @param draft - One worker-produced outbound draft.
   * @returns The selected sender acknowledgement.
   * @throws OutboundSenderRegistryError before provider I/O when the tenant differs.
   */
  async send(tenant_id: string, draft: OutboundDraft): Promise<unknown> {
    if (require_tenant_id(tenant_id) !== this.tenant_id) {
      throw new OutboundSenderRegistryError();
    }
    return this.sender.send(draft);
  }
}

/**
 * Mark a registry as explicitly responsible for every tenant that can enqueue.
 *
 * The caller must verify coverage in deployment configuration; this function
 * makes that trust boundary explicit instead of inferring it from `send`.
 */
export function mark_multi_tenant_sender_registry(
  registry: OutboundSenderRegistry,
): MultiTenantOutboundSenderRegistry {
  const sender = require_registry(registry);
  return Object.freeze({
    [MULTI_TENANT_SENDER_REGISTRY]: true as const,
    tenant_coverage: "all_tenants" as const,
    send: (tenant_id: string, draft: OutboundDraft): Promise<unknown> => sender.send(tenant_id, draft),
  });
}

/** Check the explicit all-tenant registry contract. */
export function is_multi_tenant_sender_registry(value: unknown): value is MultiTenantOutboundSenderRegistry {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<MultiTenantOutboundSenderRegistry>;
  return candidate[MULTI_TENANT_SENDER_REGISTRY] === true &&
    candidate.tenant_coverage === "all_tenants" &&
    typeof candidate.send === "function";
}

/** Map explicit tenant bindings to per-sender adapters without loading secrets. */
export class MappedOutboundSenderRegistry implements OutboundSenderRegistry {
  private readonly senders: Map<string, OutboundSenderPort>;

  /**
   * Create a registry from an already-secured tenant-to-sender map.
   *
   * @param senders - Explicit tenant bindings supplied by the deployment.
   */
  constructor(senders: ReadonlyMap<string, OutboundSenderPort>) {
    this.senders = new Map<string, OutboundSenderPort>();
    const bound_senders = new Set<OutboundSenderPort>();
    for (const [tenant_id, sender] of senders) {
      const validated_sender = require_sender(sender);
      if (bound_senders.has(validated_sender)) {
        throw new OutboundSenderRegistryError("sender-reuse");
      }
      bound_senders.add(validated_sender);
      this.senders.set(require_tenant_id(tenant_id), validated_sender);
    }
  }

  /**
   * Select and send through the tenant's configured adapter.
   *
   * @param tenant_id - Tenant carried by the claimed job.
   * @param draft - One worker-produced outbound draft.
   * @returns The selected sender acknowledgement.
   * @throws OutboundSenderRegistryError before provider I/O for an unmapped tenant.
   */
  async send(tenant_id: string, draft: OutboundDraft): Promise<unknown> {
    const sender = this.senders.get(require_tenant_id(tenant_id));
    if (sender === undefined) throw new OutboundSenderRegistryError();
    return sender.send(draft);
  }
}

function require_tenant_id(value: string): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.length > 256 ||
    value.trim() !== value
  ) {
    throw new OutboundSenderRegistryError("registry-invalid");
  }
  return value;
}

function require_sender(sender: OutboundSenderPort): OutboundSenderPort {
  if (typeof sender?.send !== "function") {
    throw new OutboundSenderRegistryError("registry-invalid");
  }
  return sender;
}

function require_registry(registry: OutboundSenderRegistry): OutboundSenderRegistry {
  if (typeof registry?.send !== "function") {
    throw new OutboundSenderRegistryError("registry-invalid");
  }
  return registry;
}
