/** Tenant-aware selection of the per-sender outbound boundary. */

import type {
  OutboundSenderPort,
  OutboundSenderRegistry,
} from "../worker/loop.js";
import type { OutboundDraft } from "../worker/process_job.js";

export type { OutboundSenderRegistry } from "../worker/loop.js";

/** Sanitized failure when a tenant has no configured outbound sender. */
export class OutboundSenderRegistryError extends Error {
  /** Stable code persisted by the worker without exposing tenant or provider data. */
  readonly code = "tenant_sender_not_configured";

  /** Create a safe registry configuration or lookup error. */
  constructor(reason: "tenant-not-configured" | "registry-invalid" = "tenant-not-configured") {
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
    for (const [tenant_id, sender] of senders) {
      this.senders.set(require_tenant_id(tenant_id), require_sender(sender));
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
