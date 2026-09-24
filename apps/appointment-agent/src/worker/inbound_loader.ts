/** Read boundary for worker-side inbound message loading. */

import type {
  InboundMessageRecord,
  InboundMessageStore,
} from "../ingress/inbound_store.js";

/** Port that loads a tenant-scoped inbound row. */
export interface InboundLoader {
  /**
   * Load one message by tenant and WAMID.
   *
   * @param tenant_id - Owning tenant.
   * @param wamid - Stable inbound message id.
   * @returns The retained row or null.
   */
  load(tenant_id: string, wamid: string): Promise<InboundMessageRecord | null>;
  /** Mark a loaded row processed when the backing store supports updates. */
  mark_processed?(tenant_id: string, wamid: string, processed_at: string): Promise<void>;
}

/** Adapt an inbound store to the worker's narrow read port. */
export class StoreInboundLoader implements InboundLoader {
  private readonly inbound_store: InboundMessageStore;

  /**
   * Create a loader.
   *
   * @param inbound_store - Persistence port supplied by composition.
   */
  constructor(inbound_store: InboundMessageStore) {
    this.inbound_store = inbound_store;
  }

  /**
   * Load one retained inbound row.
   *
   * @param tenant_id - Owning tenant.
   * @param wamid - Stable inbound message id.
   * @returns A retained row or null.
   */
  async load(tenant_id: string, wamid: string): Promise<InboundMessageRecord | null> {
    return this.inbound_store.get(tenant_id, wamid);
  }

  /**
   * Forward the processed marker to the backing store.
   *
   * @param tenant_id - Owning tenant.
   * @param wamid - Stable message id.
   * @param processed_at - ISO completion timestamp.
   * @returns Nothing.
   */
  async mark_processed(tenant_id: string, wamid: string, processed_at: string): Promise<void> {
    await this.inbound_store.mark_processed(tenant_id, wamid, processed_at);
  }
}
