import { assert_valid_tenant_id, assert_valid_wamid } from "./dedupe_contract.js";

export {
  DedupeStoreError,
  InvalidTenantIdError,
  InvalidWamidError,
  assert_valid_tenant_id,
  assert_valid_wamid,
} from "./dedupe_contract.js";

/** Tenant-scoped idempotency boundary for one inbound message. */
export interface MessageDedupeStore {
  has_seen(tenant_id: string, wamid: string): Promise<boolean>;
  try_claim(tenant_id: string, wamid: string): Promise<boolean>;
  release_claim(tenant_id: string, wamid: string): Promise<void>;
}

/** In-memory tenant-scoped dedupe store for tests and local dev. */
export class InMemoryMessageDedupe implements MessageDedupeStore {
  private readonly seen_by_tenant = new Map<string, Set<string>>();

  /**
   * Check whether a message id was already claimed for a tenant.
   *
   * @param tenant_id - Owning tenant.
   * @param wamid - Stable Meta message id.
   * @returns True when the tenant-scoped claim exists.
   * @throws InvalidTenantIdError or InvalidWamidError for invalid input.
   */
  async has_seen(tenant_id: string, wamid: string): Promise<boolean> {
    assert_dedupe_identity(tenant_id, wamid);
    return this.seen_by_tenant.get(tenant_id)?.has(wamid) ?? false;
  }

  /**
   * Claim a tenant/message pair exactly once.
   *
   * @param tenant_id - Owning tenant.
   * @param wamid - Stable Meta message id.
   * @returns True for the first claim, false for a duplicate in that tenant.
   * @throws InvalidTenantIdError or InvalidWamidError for invalid input.
   */
  async try_claim(tenant_id: string, wamid: string): Promise<boolean> {
    assert_dedupe_identity(tenant_id, wamid);
    const seen_ids = this.seen_by_tenant.get(tenant_id) ?? new Set<string>();
    if (seen_ids.has(wamid)) return false;
    seen_ids.add(wamid);
    this.seen_by_tenant.set(tenant_id, seen_ids);
    return true;
  }

  /**
   * Release a tenant/message claim after downstream enqueue failure.
   *
   * @param tenant_id - Owning tenant.
   * @param wamid - Stable Meta message id whose claim should be removed.
   * @returns Nothing.
   * @throws InvalidTenantIdError or InvalidWamidError for invalid input.
   */
  async release_claim(tenant_id: string, wamid: string): Promise<void> {
    assert_dedupe_identity(tenant_id, wamid);
    const seen_ids = this.seen_by_tenant.get(tenant_id);
    if (seen_ids === undefined) return;
    seen_ids.delete(wamid);
    if (seen_ids.size === 0) this.seen_by_tenant.delete(tenant_id);
  }
}

function assert_dedupe_identity(tenant_id: string, wamid: string): void {
  assert_valid_tenant_id(tenant_id);
  assert_valid_wamid(wamid);
}

export { PostgresMessageDedupe } from "./postgres_dedupe.js";
