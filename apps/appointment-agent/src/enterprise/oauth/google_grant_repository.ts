/**
 * Persistence port for encrypted Google Calendar grants.
 *
 * The grant record is separated from the store that owns it because the two have
 * opposite security properties. The store holds the cipher and therefore handles
 * plaintext, briefly, inside one callback. The repository only ever sees the
 * ciphertext envelope: a row copied out of the database into another tenant, or
 * into another purpose, still fails the GCM authentication check on open.
 *
 * Keeping the split at this boundary is what makes a durable adapter safe by
 * construction rather than by review — there is no method on this port a caller
 * could use to persist a raw refresh token, because none of them accept one.
 *
 * The port lives here, below `google_token_grants`, so the dependency runs one
 * way: the store depends on its persistence, never the reverse.
 */

import { OAuthFlowError } from "./oauth_error.js";

/** One tenant's stored Calendar grant. */
export interface GoogleTokenGrant {
  grant_id: string;
  tenant_id: string;
  /** Google account that granted access, as the provider's opaque subject id. */
  google_subject_id: string;
  /** Staff subject that completed the consent callback. */
  authorized_by_subject_id: string;
  scopes: readonly string[];
  /** Ciphertext only; the refresh token never exists in this record. */
  encrypted_refresh_token: string;
  created_at_iso: string;
  last_used_at_iso: string | null;
  revoked_at_iso: string | null;
}

/**
 * Port for grant persistence.
 *
 * Every method is keyed by tenant and carries the ciphertext envelope. None of
 * them accepts, returns, or derives a plaintext refresh token.
 */
export interface GoogleTokenGrantRepository {
  /** Read one tenant's grant, revoked rows included so revoke stays auditable. */
  load(tenant_id: string): Promise<GoogleTokenGrant | null>;
  /**
   * Insert or replace the tenant's active grant.
   *
   * Re-consent replaces rather than accumulates, which keeps the tenant-to-account
   * mapping single-valued and therefore auditable.
   *
   * @param grant - Grant whose refresh token field is already ciphertext.
   * @returns The stored row.
   */
  replace(grant: GoogleTokenGrant): Promise<GoogleTokenGrant>;
  /** Stamp the last successful use of the tenant's active grant. */
  mark_used(tenant_id: string, at_iso: string): Promise<void>;
  /** Record that the tenant's grant is no longer usable, without deleting it. */
  mark_unusable(tenant_id: string, at_iso: string): Promise<void>;
  /**
   * Delete the tenant's row only while it is still the named grant.
   *
   * A revoke suspends on the provider call, so a re-consent can land in that
   * window. Deleting by tenant instead would destroy a newer credential Google
   * never invalidated, which is exactly the un-revocable state two-sided
   * revocation exists to prevent.
   *
   * @param tenant_id - Tenant whose row would be retired.
   * @param grant_id - Identity of the grant the caller revoked.
   * @returns True when the stored row was that grant and is now gone.
   */
  delete_if(tenant_id: string, grant_id: string): Promise<boolean>;
  /** List the mapping, optionally narrowed to one tenant. */
  list(tenant_id?: string): Promise<GoogleTokenGrant[]>;
}

/** Explicit process-local repository for tests and loopback-only composition. */
export class InMemoryGoogleTokenGrantRepository implements GoogleTokenGrantRepository {
  private readonly grants = new Map<string, GoogleTokenGrant>();

  /** Read one tenant's stored grant. */
  async load(tenant_id: string): Promise<GoogleTokenGrant | null> {
    const found = this.grants.get(require_grant_tenant_id(tenant_id));
    return found === undefined ? null : copy_grant(found);
  }

  /** Insert or replace the tenant's active grant. */
  async replace(grant: GoogleTokenGrant): Promise<GoogleTokenGrant> {
    const key = require_grant_tenant_id(grant.tenant_id);
    this.grants.set(key, copy_grant(grant));
    return copy_grant(grant);
  }

  /** Stamp last use on the tenant's active grant. */
  async mark_used(tenant_id: string, at_iso: string): Promise<void> {
    const row = this.grants.get(require_grant_tenant_id(tenant_id));
    if (row !== undefined) this.grants.set(row.tenant_id, { ...row, last_used_at_iso: at_iso });
  }

  /** Mark the tenant's stored grant unusable without removing it. */
  async mark_unusable(tenant_id: string, at_iso: string): Promise<void> {
    const row = this.grants.get(require_grant_tenant_id(tenant_id));
    if (row !== undefined) this.grants.set(row.tenant_id, { ...row, revoked_at_iso: at_iso });
  }

  /** Compare-and-delete the tenant's row against the revoked grant identity. */
  async delete_if(tenant_id: string, grant_id: string): Promise<boolean> {
    const key = require_grant_tenant_id(tenant_id);
    const stored = this.grants.get(key);
    if (stored === undefined || stored.grant_id !== grant_id) return false;
    this.grants.delete(key);
    return true;
  }

  /** List the mapping, oldest tenant first, without mutating stored rows. */
  async list(tenant_id?: string): Promise<GoogleTokenGrant[]> {
    const all = [...this.grants.values()];
    const filtered = tenant_id === undefined
      ? all
      : all.filter((grant) => grant.tenant_id === require_grant_tenant_id(tenant_id));
    return filtered.map(copy_grant).sort((left, right) => left.tenant_id.localeCompare(right.tenant_id));
  }
}

/** Validate a tenant id without echoing it. */
export function require_grant_tenant_id(value: string): string {
  if (typeof value !== "string" || !/^[1-9]\d{0,18}$/.test(value)) {
    throw new OAuthFlowError("oauth_tenant_mismatch");
  }
  return value;
}

/** Defensive copy so a caller cannot mutate a stored row through a return value. */
function copy_grant(grant: GoogleTokenGrant): GoogleTokenGrant {
  return { ...grant, scopes: [...grant.scopes] };
}
