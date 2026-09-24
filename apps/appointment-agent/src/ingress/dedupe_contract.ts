const MAX_WAMID_LENGTH = 128;
const MAX_TENANT_ID_LENGTH = 256;

/** Signals that a WhatsApp message id violates the bounded input contract. */
export class InvalidWamidError extends Error {
  constructor() {
    super("invalid-wamid");
    this.name = "InvalidWamidError";
  }
}

/** Signals that a tenant identifier violates the bounded input contract. */
export class InvalidTenantIdError extends Error {
  constructor() {
    super("invalid-tenant-id");
    this.name = "InvalidTenantIdError";
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

/**
 * Validate a tenant identifier before any store access.
 *
 * The database owns the numeric BIGINT representation; this boundary keeps the
 * adapter contract bounded without silently coercing a missing tenant.
 *
 * Args:
 *   tenant_id: Tenant that owns the message claim.
 *
 * Raises:
 *   InvalidTenantIdError: If the identifier is empty or exceeds the length bound.
 */
export function assert_valid_tenant_id(tenant_id: string): void {
  if (
    typeof tenant_id !== "string" ||
    tenant_id.trim() === "" ||
    tenant_id.length > MAX_TENANT_ID_LENGTH
  ) {
    throw new InvalidTenantIdError();
  }
}
