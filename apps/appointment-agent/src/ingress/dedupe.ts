const MAX_WAMID_LENGTH = 128;

export class InvalidWamidError extends Error {
  constructor() {
    super("invalid-wamid");
    this.name = "InvalidWamidError";
  }
}

export class DedupeStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DedupeStoreError";
  }
}

export interface MessageDedupeStore {
  has_seen(wamid: string): Promise<boolean>;
  try_claim(wamid: string): Promise<boolean>;
}

/**
 * Validate a WhatsApp message id before any store access.
 *
 * Args:
 *   wamid: Stable Meta message id (wamid.*).
 *
 * Raises:
 *   InvalidWamidError: If the id is empty or exceeds the length bound.
 */
export function assert_valid_wamid(wamid: string): void {
  if (typeof wamid !== "string" || wamid.length === 0 || wamid.length > MAX_WAMID_LENGTH) {
    throw new InvalidWamidError();
  }
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
}

/**
 * Postgres dedupe store backed by a unique constraint on wamid.
 *
 * Not yet wired: production inserts into a table such as
 * processed_messages(wamid PK, created_at) and maps a unique
 * violation to "duplicate" (return false from try_claim).
 */
// TODO(backend): Wire PostgresMessageDedupe to the app datasource after the processed_messages table lands.
export class PostgresMessageDedupe implements MessageDedupeStore {
  /**
   * Create the store. Holds no connection itself; pass a query runner later.
   */
  constructor() {}

  async has_seen(_wamid: string): Promise<boolean> {
    throw new DedupeStoreError("postgres-dedupe-not-wired");
  }

  async try_claim(_wamid: string): Promise<boolean> {
    throw new DedupeStoreError("postgres-dedupe-not-wired");
  }
}
