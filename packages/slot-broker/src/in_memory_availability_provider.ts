/** In-memory availability provider for deterministic tests and local wiring. */

import type { SearchIntent, TenantAvailability, TenantAvailabilityProvider } from "./types.js";
import { validate_availability_set } from "./validation.js";

function clone_availability(availability: TenantAvailability): TenantAvailability {
  return {
    ...availability,
    slots: availability.slots.map((slot) => ({ ...slot })),
  };
}

/** A snapshot provider that returns cloned availability and has no mutation API. */
export class InMemoryTenantAvailabilityProvider implements TenantAvailabilityProvider {
  private readonly availability_snapshot: readonly TenantAvailability[];

  /**
   * Create a provider over a copied availability snapshot.
   *
   * Args:
   *   availabilities: Partner records to expose. The default is an empty set.
   *
   * Raises:
   *   SlotBrokerValidationError: If the seed data violates the port contract.
   */
  public constructor(availabilities: readonly TenantAvailability[] = []) {
    validate_availability_set(availabilities);
    this.availability_snapshot = availabilities.map(clone_availability);
  }

  /**
   * Return a cloned snapshot without mutating or reserving anything.
   *
   * Args:
   *   intent: Request context; the in-memory fixture returns no records without consent.
   *
   * Returns:
   *   A fresh array of cloned partner records.
   */
  public async get_availability(intent: SearchIntent): Promise<readonly TenantAvailability[]> {
    if (intent.consent_granted !== true) return [];
    return this.availability_snapshot.map(clone_availability);
  }
}
