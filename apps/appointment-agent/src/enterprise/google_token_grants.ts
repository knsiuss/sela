/**
 * Per-tenant Google Calendar refresh tokens, encrypted at rest and auditable.
 *
 * A Calendar refresh token is a long-lived credential: whoever holds it can read
 * and write the tenant's calendar indefinitely. It is therefore stored only as
 * ciphertext produced by the shared tenant-bound cipher, keyed by tenant *and*
 * purpose, so a row copied into another tenant fails to decrypt rather than
 * silently working. Raw tokens exist only in the memory of one consent callback
 * and are never logged, audited, or returned from this module.
 *
 * The "which tenant authorized which Google account" mapping is the record
 * itself, and it stores the provider's opaque subject id rather than an email
 * address: the mapping stays auditable without adding a PII field to the audit
 * and revocation surface.
 *
 * Revocation is two-sided and both halves are required. `revoke_google_grant`
 * asks Google to invalidate the grant and only then deletes the local row,
 * because the Google call is what stops a leaked copy of the ciphertext from
 * being useful after a local deletion: deleting a row cannot un-mint a
 * credential the provider already issued. A failed revoke therefore leaves the
 * grant stored and resolvable so it can be retried.
 */

import { randomUUID } from "node:crypto";
import type { TenantSecretCipher } from "../security/tenant_secret_cipher.js";
import {
  record_oauth_event,
  type OAuthAuditSink,
} from "./oauth/oauth_audit.js";
import { OAuthFlowError } from "./oauth/oauth_error.js";
import type { MetricsSink } from "../observability/metrics.js";

/** Cipher context purpose binding for Calendar refresh tokens. */
export const GOOGLE_TOKEN_PURPOSE = "google_refresh_token";

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

/** Input for storing a freshly consented refresh token. */
export interface StoreGoogleGrantInput {
  tenant_id: string;
  google_subject_id: string;
  authorized_by_subject_id: string;
  scopes: readonly string[];
  refresh_token: string;
}

/** Options for the audit and clock wiring. */
export interface GoogleGrantStoreOptions {
  sink?: OAuthAuditSink;
  metrics?: MetricsSink;
  clock?: () => Date;
  /**
   * Injectable Google-side revoke so tests never touch the network.
   *
   * A deployment supplies a closure over its client credentials; the store never
   * holds them itself, which keeps a client secret out of this module.
   */
  revoke_upstream?: (refresh_token: string) => Promise<void>;
}

/**
 * Encrypted, tenant-scoped store for Google Calendar refresh tokens.
 *
 * One tenant holds at most one active grant. Re-consent replaces the previous
 * grant for that tenant, which is what makes a rotated credential replace rather
 * than accumulate, and it keeps the tenant-to-account mapping single-valued and
 * therefore auditable.
 */
export class GoogleTokenGrantStore {
  private readonly cipher: TenantSecretCipher;
  private readonly sink: OAuthAuditSink | undefined;
  private readonly metrics: MetricsSink | undefined;
  private readonly clock: () => Date;
  private readonly revoke_upstream: ((refresh_token: string) => Promise<void>) | undefined;
  private readonly grants = new Map<string, GoogleTokenGrant>();

  /**
   * Create the store over an existing tenant-bound cipher.
   *
   * @param cipher - Cipher built from the deployment's overlap key ring.
   * @param options - Optional audit sink, metrics, clock, and upstream revoke.
   */
  constructor(cipher: TenantSecretCipher, options: GoogleGrantStoreOptions = {}) {
    this.cipher = cipher;
    this.sink = options.sink;
    this.metrics = options.metrics;
    this.clock = options.clock ?? (() => new Date());
    this.revoke_upstream = options.revoke_upstream;
  }

  /**
   * Encrypt and store one tenant's refresh token.
   *
   * @param input - Tenant, Google subject, authorizing staff subject, scopes, token.
   * @returns The stored grant, whose refresh token field is ciphertext.
   * @throws OAuthFlowError when any field is unusable or encryption fails.
   */
  async store(input: StoreGoogleGrantInput): Promise<GoogleTokenGrant> {
    const tenant_id = require_tenant_id(input?.tenant_id);
    const grant: GoogleTokenGrant = {
      grant_id: randomUUID(),
      tenant_id,
      google_subject_id: require_opaque(input.google_subject_id),
      authorized_by_subject_id: require_opaque(input.authorized_by_subject_id),
      scopes: require_scopes(input.scopes),
      encrypted_refresh_token: this.seal(input.refresh_token, tenant_id),
      created_at_iso: this.clock().toISOString(),
      last_used_at_iso: null,
      revoked_at_iso: null,
    };
    this.grants.set(tenant_id, grant);
    this.audit("calendar_grant_stored", "ok", tenant_id);
    return { ...grant, scopes: [...grant.scopes] };
  }

  /**
   * Resolve a tenant's refresh token for immediate use by the calendar client.
   *
   * @param tenant_id - Tenant requesting calendar access.
   * @returns The decrypted refresh token for one immediate token exchange.
   * @throws OAuthFlowError when the tenant has no grant or the ciphertext fails.
   */
  async resolve_refresh_token(tenant_id: string): Promise<string> {
    const tenant = require_tenant_id(tenant_id);
    const grant = this.grants.get(tenant);
    if (grant === undefined || grant.revoked_at_iso !== null) {
      this.audit("calendar_grant_stored", "missing", tenant);
      throw new OAuthFlowError("oauth_membership_unresolved");
    }
    const refresh_token = this.open(grant, tenant);
    grant.last_used_at_iso = this.clock().toISOString();
    return refresh_token;
  }

  /**
   * Record that a grant is unusable because its upstream credential was revoked.
   *
   * @param tenant_id - Tenant whose grant stopped working.
   * @throws OAuthFlowError when the tenant has no grant.
   */
  async mark_unusable(tenant_id: string): Promise<void> {
    const tenant = require_tenant_id(tenant_id);
    const grant = this.grants.get(tenant);
    if (grant === undefined) throw new OAuthFlowError("oauth_membership_unresolved");
    grant.revoked_at_iso = this.clock().toISOString();
    this.audit("calendar_grant_revoked", "revoked", tenant);
  }

  /**
   * Revoke a grant on both sides: at Google first, then locally.
   *
   * The order is the security-relevant part. Google is asked to invalidate the
   * credential *before* the local row is destroyed, so a grant that could still
   * be decrypted is also one that could still be revoked. A failing or absent
   * upstream revoker leaves the row intact and resolvable, so an operator can
   * retry the revoke from the runbook instead of having lost the only copy of the
   * token needed to attempt it.
   *
   * @param tenant_id - Tenant whose grant is being withdrawn.
   * @returns True once Google has also invalidated the grant.
   * @throws OAuthFlowError when the tenant has no stored grant, when no upstream
   * revoker is wired, or when Google did not accept the revoke. In every failure
   * case the grant is left stored and revocable.
   */
  async revoke_google_grant(tenant_id: string): Promise<boolean> {
    const tenant = require_tenant_id(tenant_id);
    const grant = this.grants.get(tenant);
    if (grant === undefined) {
      this.audit("calendar_grant_revoked", "missing", tenant);
      throw new OAuthFlowError("oauth_membership_unresolved");
    }
    // Checked before anything is decrypted or destroyed, so a store with no
    // revoker refuses without touching the row it could not revoke.
    const revoke_upstream = this.require_revoker();
    const refresh_token = this.open(grant, tenant);
    try {
      await revoke_upstream(refresh_token);
    } catch {
      // The credential is still live at Google and still decryptable here, so
      // the row must survive: this is a retryable failure, not a completed
      // revocation. Collapsing the upstream error keeps the token and any
      // provider wording out of the failure a caller will log or render.
      this.audit("calendar_grant_revoked", "failed", tenant);
      throw new OAuthFlowError("oauth_token_exchange_failed");
    }
    this.grants.delete(tenant);
    this.audit("calendar_grant_revoked", "revoked", tenant);
    return true;
  }

  /**
   * List the tenant-to-account mapping without any credential material.
   *
   * @param tenant_id - Optional tenant filter; omit to list every grant.
   * @returns Grants safe to render in an audit view.
   */
  list(tenant_id?: string): GoogleTokenGrant[] {
    const all = [...this.grants.values()];
    const filtered = tenant_id === undefined ? all : all.filter((grant) => grant.tenant_id === require_tenant_id(tenant_id));
    return filtered
      .map((grant) => ({ ...grant, scopes: [...grant.scopes], encrypted_refresh_token: "[redacted]" }))
      .sort((left, right) => left.tenant_id.localeCompare(right.tenant_id));
  }

  /** Encrypt one refresh token bound to its tenant and purpose. */
  private seal(refresh_token: string, tenant_id: string): string {
    try {
      return this.cipher.encrypt(require_refresh_token(refresh_token), {
        tenant_id,
        purpose: GOOGLE_TOKEN_PURPOSE,
      });
    } catch {
      throw new OAuthFlowError("oauth_token_exchange_failed");
    }
  }

  /**
   * Require the injected Google-side revoker before anything is destroyed.
   *
   * @returns The wired revoker.
   * @throws OAuthFlowError when none is wired; the store holds no client
   * credentials of its own, so it must not pretend the provider side was cleared.
   */
  private require_revoker(): (refresh_token: string) => Promise<void> {
    if (this.revoke_upstream === undefined) {
      throw new OAuthFlowError("oauth_configuration_invalid");
    }
    return this.revoke_upstream;
  }

  /** Decrypt one grant for its own tenant only. */
  private open(grant: GoogleTokenGrant, tenant_id: string): string {
    try {
      return this.cipher.decrypt(grant.encrypted_refresh_token, {
        tenant_id,
        purpose: GOOGLE_TOKEN_PURPOSE,
      });
    } catch {
      this.audit("calendar_grant_stored", "failed", tenant_id);
      throw new OAuthFlowError("oauth_token_exchange_failed");
    }
  }

  /** Record a credential-adjacent event without tenant or token material. */
  private audit(
    event: "calendar_grant_stored" | "calendar_grant_revoked",
    outcome: "ok" | "missing" | "failed" | "revoked",
    tenant_id: string,
  ): void {
    record_oauth_event(this.sink, this.metrics, {
      event,
      outcome,
      tenant_id,
      idp: "google",
      at: this.clock().toISOString(),
    });
  }
}

/** Validate a tenant id without echoing it. */
function require_tenant_id(value: string): string {
  if (typeof value !== "string" || !/^[1-9]\d{0,18}$/.test(value)) {
    throw new OAuthFlowError("oauth_tenant_mismatch");
  }
  return value;
}

/** Require a bounded, control-character-free opaque identifier. */
function require_opaque(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  return value;
}

/** Require a non-empty refresh token without echoing it. */
function require_refresh_token(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  return value;
}

/** Require a bounded, de-duplicated scope list. */
function require_scopes(value: readonly string[]): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  for (const scope of value) {
    if (typeof scope !== "string" || scope.length === 0 || scope.length > 256) {
      throw new OAuthFlowError("oauth_configuration_invalid");
    }
  }
  return Object.freeze([...new Set(value)]);
}
