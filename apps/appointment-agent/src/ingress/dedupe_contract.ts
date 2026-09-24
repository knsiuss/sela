const MAX_WAMID_LENGTH = 128;

/** Signals that a WhatsApp message id violates the bounded input contract. */
export class InvalidWamidError extends Error {
  constructor() {
    super("invalid-wamid");
    this.name = "InvalidWamidError";
  }
}

/** Signals a persistence failure at the dedupe adapter boundary. */
export class DedupeStoreError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "DedupeStoreError";
  }
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
