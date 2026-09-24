import { assert_valid_wamid } from "./dedupe_contract.js";

export { DedupeStoreError, InvalidWamidError, assert_valid_wamid } from "./dedupe_contract.js";

export interface MessageDedupeStore {
  has_seen(wamid: string): Promise<boolean>;
  try_claim(wamid: string): Promise<boolean>;
  release_claim(wamid: string): Promise<void>;
}

/** In-memory dedupe store for tests and local dev. */
export class InMemoryMessageDedupe implements MessageDedupeStore {
  private seen_ids = new Set<string>();

  /**
   * Check whether a message id was already claimed.
   *
   * Args:
   *   wamid: Stable Meta message id.
   *
   * Returns:
   *   True when already seen, false otherwise.
   *
   * Raises:
   *   InvalidWamidError: If the id is empty or too long.
   */
  async has_seen(wamid: string): Promise<boolean> {
    assert_valid_wamid(wamid);
    return this.seen_ids.has(wamid);
  }

  /**
   * Claim a message id exactly once.
   *
   * First caller gets true and should process the message; every
   * later caller gets false and should ACK 200 without reprocessing.
   *
   * Args:
   *   wamid: Stable Meta message id.
   *
   * Returns:
   *   True when this call claimed the id, false when it is a duplicate.
   *
   * Raises:
   *   InvalidWamidError: If the id is empty or too long.
   */
  async try_claim(wamid: string): Promise<boolean> {
    assert_valid_wamid(wamid);
    if (this.seen_ids.has(wamid)) return false;
    this.seen_ids.add(wamid);
    return true;
  }

  /**
   * Release a claim after its downstream enqueue step failed.
   *
   * Args:
   *   wamid: Stable Meta message id whose claim should be removed.
   *
   * Raises:
   *   InvalidWamidError: If the id is empty or too long.
   */
  async release_claim(wamid: string): Promise<void> {
    assert_valid_wamid(wamid);
    this.seen_ids.delete(wamid);
  }
}

export { PostgresMessageDedupe } from "./postgres_dedupe.js";
