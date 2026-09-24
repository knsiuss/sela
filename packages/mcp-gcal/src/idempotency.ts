import { createHash } from "node:crypto";

/** Event id derived from the tenant calendar and caller idempotency key. */
export function derive_event_id(calendar_id: string, idempotency_key: string): string {
  return `sela${createHash("sha256")
    .update(`${calendar_id}\u0000${idempotency_key}`)
    .digest("hex")}`;
}
