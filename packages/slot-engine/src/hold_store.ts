/** In-memory TTL hold store for appointment slots.
 *
 * Holds the short-lived lease created between "customer picks a slot" and
 * "customer confirms". This is the MVP fast store; it is swapped for Redis
 * (SET NX EX on the slot key) later without changing callers, because the
 * interface is limited to acquire/release/lookup keyed by slot key.
 */

import { randomUUID } from "node:crypto";
import {
  MAX_HOLD_TTL_SECONDS,
  build_slot_key,
  type Hold,
} from "./slot_types.js";

export interface AcquireHoldParams {
  tenant_id: string;
  provider_id: string;
  start_time: string;
  end_time: string;
  ttl_seconds?: number;
}

export interface ReleaseHoldParams {
  hold_id: string;
}

export interface FindHoldParams {
  hold_id: string;
}

export interface SlotHeldQuery {
  slot_key: string;
}

interface StoredHold extends Hold {
  expires_at_ms: number;
}

function log_event(event: string, details: Record<string, string | number>): void {
  console.info(JSON.stringify({ component: "hold-store", event, ...details }));
}

/**
 * Lease registry for slot keys with strict server-side TTL.
 *
 * Expiry is evaluated lazily on every read (no background timers), so the
 * store stays embeddable and deterministic under test. Expired entries are
 * purged as they are encountered and never handed out.
 */
export class HoldStore {
  private holds_by_id = new Map<string, StoredHold>();
  private hold_id_by_slot_key = new Map<string, string>();
  private readonly clock: () => number;

  /**
   * Create a hold store.
   *
   * Args:
   *   clock: Current time in epoch milliseconds. Defaults to Date.now;
   *     tests inject a manual clock for deterministic TTL behavior.
   */
  constructor(clock: () => number = Date.now) {
    this.clock = clock;
  }

  /**
   * Acquire a lease for a slot key.
   *
   * Args:
   *   params: Tenant, provider, window, and optional requested TTL.
   *     Requested TTL is clamped to MAX_HOLD_TTL_SECONDS server-side.
   *
   * Returns:
   *   The new hold, or null when a live hold already covers the slot key.
   */
  acquire(params: AcquireHoldParams): Hold | null {
    const now_ms = this.clock();
    this.purge_expired(now_ms);
    const slot_key = build_slot_key(params);
    if (this.hold_id_by_slot_key.has(slot_key)) {
      return null;
    }
    const ttl_seconds = Math.min(params.ttl_seconds ?? MAX_HOLD_TTL_SECONDS, MAX_HOLD_TTL_SECONDS);
    const expires_at_ms = now_ms + ttl_seconds * 1000;
    const stored: StoredHold = {
      hold_id: `hold_${randomUUID()}`,
      slot_key,
      tenant_id: params.tenant_id,
      provider_id: params.provider_id,
      start_time: params.start_time,
      end_time: params.end_time,
      expires_at: new Date(expires_at_ms).toISOString(),
      created_at: new Date(now_ms).toISOString(),
      expires_at_ms,
    };
    this.holds_by_id.set(stored.hold_id, stored);
    this.hold_id_by_slot_key.set(slot_key, stored.hold_id);
    // Log carries only internal ids and window bounds, never customer data.
    log_event("hold_acquired", { hold_id: stored.hold_id, slot_key });
    return this.to_public_hold(stored);
  }

  /**
   * Release a lease by hold id.
   *
   * Args:
   *   params: Hold id to release.
   *
   * Returns:
   *   True when a hold was removed, false when the id was unknown.
   */
  release(params: ReleaseHoldParams): boolean {
    const stored = this.holds_by_id.get(params.hold_id);
    if (!stored) {
      return false;
    }
    this.holds_by_id.delete(params.hold_id);
    this.hold_id_by_slot_key.delete(stored.slot_key);
    log_event("hold_released", { hold_id: params.hold_id, slot_key: stored.slot_key });
    return true;
  }

  /**
   * Look up a live hold by id.
   *
   * Expired holds are purged and reported as missing, so callers fail
   * closed without needing their own TTL math.
   *
   * Args:
   *   params: Hold id to look up.
   *
   * Returns:
   *   The live hold, or undefined when unknown or expired.
   */
  find_hold(params: FindHoldParams): Hold | undefined {
    const stored = this.holds_by_id.get(params.hold_id);
    if (!stored) {
      return undefined;
    }
    if (stored.expires_at_ms <= this.clock()) {
      this.release(params);
      log_event("hold_expired", { hold_id: params.hold_id, slot_key: stored.slot_key });
      return undefined;
    }
    return this.to_public_hold(stored);
  }

  /**
   * Check whether a slot key currently carries a live hold.
   *
   * Args:
   *   params: Slot key to check.
   *
   * Returns:
   *   True when a live hold exists for the key.
   */
  is_held(params: SlotHeldQuery): boolean {
    this.purge_expired(this.clock());
    return this.hold_id_by_slot_key.has(params.slot_key);
  }

  /**
   * Count live holds after purging expired ones.
   *
   * Returns:
   *   Number of unexpired holds currently stored.
   */
  live_count(): number {
    this.purge_expired(this.clock());
    return this.holds_by_id.size;
  }

  private purge_expired(now_ms: number): void {
    for (const [hold_id, stored] of this.holds_by_id) {
      if (stored.expires_at_ms <= now_ms) {
        this.holds_by_id.delete(hold_id);
        this.hold_id_by_slot_key.delete(stored.slot_key);
        log_event("hold_expired", { hold_id, slot_key: stored.slot_key });
      }
    }
  }

  private to_public_hold(stored: StoredHold): Hold {
    const { expires_at_ms: _internal, ...public_hold } = stored;
    return public_hold;
  }
}
