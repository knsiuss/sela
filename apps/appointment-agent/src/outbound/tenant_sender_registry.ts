/** Lazy per-tenant WhatsApp sender registry backed by credential revocation. */

import { MetaGraphTransport, WhatsAppSender } from "@repo/wa-sender";
import type { OutboundSenderPort, OutboundSenderRegistry } from "../worker/loop.js";
import type { OutboundDraft } from "../worker/process_job.js";
import {
  OutboundSenderRegistryError,
} from "./sender_registry.js";
import { SecretManagerError } from "../security/secret_manager.js";
import { WhatsAppSenderAdapter } from "./whatsapp_sender_adapter.js";
import type { TenantSenderCredentials, TenantSenderCredentialStore } from "../security/tenant_sender_credentials.js";
import { DEFAULT_WHATSAPP_GRAPH_API_URL } from "./runtime_sender.js";

/** Options for the secret-backed tenant sender registry. */
export interface TenantSenderRegistryOptions {
  /** Per-tenant credential store; owns revocation state. */
  credential_store: TenantSenderCredentialStore;
  /** Pinned Graph API base URL; defaults to the verified version. */
  graph_api_url?: string;
  /** Bounded provider request timeout in milliseconds. */
  request_timeout_ms?: number;
  /** Test override for sender construction; production builds Meta senders. */
  sender_factory?: (
    credentials: TenantSenderCredentials,
    tenant_id: string,
  ) => OutboundSenderPort;
}

/**
 * Resolve and cache one Meta sender per tenant at send time.
 *
 * Credentials resolve lazily so rotation applies to new sends without a
 * restart. Revoked or unmapped tenants fail closed before provider I/O with
 * the shared sanitized registry code.
 */
export class TenantSecretSenderRegistry implements OutboundSenderRegistry {
  private readonly credential_store: TenantSenderCredentialStore;
  private readonly graph_api_url: string;
  private readonly request_timeout_ms: number;
  private readonly sender_factory: (
    credentials: TenantSenderCredentials,
    tenant_id: string,
  ) => OutboundSenderPort;
  private readonly senders = new Map<string, OutboundSenderPort>();

  /**
   * Create the registry over a credential store.
   *
   * @param options - Credential store and transport tuning.
   */
  constructor(options: TenantSenderRegistryOptions) {
    this.credential_store = options.credential_store;
    this.graph_api_url = options.graph_api_url ?? DEFAULT_WHATSAPP_GRAPH_API_URL;
    this.request_timeout_ms = options.request_timeout_ms ?? 10_000;
    this.sender_factory = options.sender_factory ?? ((credentials) => build_meta_sender(
      credentials,
      this.graph_api_url,
      this.request_timeout_ms,
    ));
  }

  /**
   * List tenants with a credential binding in stable order.
   *
   * @returns Sorted tenant ids; revoked tenants remain listed until restart.
   */
  configured_tenants(): string[] {
    return this.credential_store.configured_tenants();
  }

  /**
   * Emergency-revoke one tenant and drop its cached sender.
   *
   * @param tenant_id - Tenant to revoke for this process lifetime.
   */
  revoke_tenant(tenant_id: string): void {
    this.credential_store.revoke(tenant_id);
    this.senders.delete(tenant_id);
  }

  /**
   * Drop one tenant's cached sender without changing credential state.
   *
   * Tenant erasure calls this so a deleted tenant can never send through a
   * stale cached adapter; the next send resolves credentials afresh.
   *
   * @param tenant_id - Tenant whose cached sender must be forgotten.
   */
  evict_cached_sender(tenant_id: string): void {
    this.senders.delete(tenant_id);
  }

  /**
   * Send one draft through the tenant's resolved sender.
   *
   * @param tenant_id - Tenant carried by the claimed job.
   * @param draft - Tenant-safe outbound draft.
   * @returns The selected sender acknowledgement.
   * @throws OutboundSenderRegistryError before provider I/O for unmapped tenants.
   */
  async send(tenant_id: string, draft: OutboundDraft): Promise<unknown> {
    if (this.credential_store.is_revoked(tenant_id)) {
      this.senders.delete(tenant_id);
      throw new OutboundSenderRegistryError();
    }
    let sender = this.senders.get(tenant_id);
    if (sender === undefined) {
      const credentials = resolve_credentials(this.credential_store, tenant_id);
      sender = this.sender_factory(credentials, tenant_id);
      this.senders.set(tenant_id, sender);
    }
    return sender.send(draft);
  }
}

/**
 * Build the default Meta sender adapter for one tenant.
 *
 * @param credentials - Credentials resolved for immediate use only.
 * @param graph_api_url - Pinned Graph API base URL.
 * @param request_timeout_ms - Bounded provider timeout.
 * @returns Adapter bound to the tenant's credentials.
 */
export function build_meta_sender(
  credentials: TenantSenderCredentials,
  graph_api_url: string,
  request_timeout_ms: number,
): OutboundSenderPort {
  return new WhatsAppSenderAdapter(
    new WhatsAppSender(
      new MetaGraphTransport({
        graph_api_url,
        phone_number_id: credentials.phone_number_id,
        access_token: credentials.access_token,
        request_timeout_ms,
      }),
    ),
  );
}

/** Resolve credentials while translating failures to the registry contract. */
function resolve_credentials(
  store: TenantSenderCredentialStore,
  tenant_id: string,
): TenantSenderCredentials {
  try {
    return store.resolve(tenant_id);
  } catch (error) {
    if (error instanceof SecretManagerError) throw new OutboundSenderRegistryError();
    throw error;
  }
}
