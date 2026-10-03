/**
 * Server-side staff sessions with revocation, TTL, and hash-only secrets.
 *
 * A browser cookie is a bearer credential, so it needs a server-side record that
 * can be revoked. This store keeps that record and delegates every lifecycle
 * decision to the existing `session_registry` contracts, so revocation semantics
 * (`revoke-once`, hashed device history, `list_subject_sessions`) stay identical
 * to the audited operator session behavior rather than being reimplemented.
 *
 * Session fixation is prevented by `issue_session_secret`: the identifier and the
 * secret are both drawn fresh at authentication time and are never derived from
 * anything the client supplied.
 */

import {
  hash_device,
  InMemorySessionRegistry,
  is_session_revoked,
  register_session,
  revoke_session,
  touch_session,
  type RegisterSessionInput,
  type SessionRecord,
} from "../session_registry.js";
import {
  parse_authenticated_principal,
  type AuthenticatedPrincipal,
  type EnterpriseRole,
} from "../authorization.js";
import { OAuthFlowError } from "./oauth_error.js";
import {
  hash_session_secret,
  issue_session_secret,
  parse_session_cookie,
  secret_matches,
  type IssuedSessionSecret,
} from "./session_cookie.js";

/** Identity provider that authenticated the session. */
export type SessionIdp = "supabase" | "google";

/** One stored staff session; never carries a raw secret. */
export interface StaffSessionRecord {
  session: SessionRecord;
  subject_id: string;
  issuer: string;
  idp: SessionIdp;
  secret_hash: string;
  /** Real MFA evidence from the ID token; never inferred or defaulted true. */
  has_mfa: boolean;
  tenant_roles: Readonly<Record<string, readonly string[]>>;
  expires_at_ms: number;
}

/** Everything needed to establish one authenticated staff session. */
export interface CreateStaffSessionInput {
  subject_id: string;
  issuer: string;
  idp: SessionIdp;
  has_mfa: boolean;
  principal: AuthenticatedPrincipal;
  device_id: string;
  ttl_seconds: number;
  secret?: IssuedSessionSecret;
}

/** An established session plus the one-time cookie value. */
export interface EstablishedStaffSession {
  record: StaffSessionRecord;
  cookie_value: string;
}

/** Port for session persistence; a shared adapter replaces this in production. */
export interface StaffSessionStore {
  /** Establish a new session for a verified principal. */
  create(input: CreateStaffSessionInput): Promise<EstablishedStaffSession>;
  /**
   * Resolve a cookie to a live session.
   *
   * @param cookie_value - Raw `<id>.<secret>` cookie value.
   * @returns The live session record.
   * @throws OAuthFlowError when the session is absent, expired, revoked, or the
   * secret does not match.
   */
  resolve(cookie_value: string): Promise<StaffSessionRecord>;
  /** Revoke a session; a second revocation fails loudly. */
  revoke(session_id: string): Promise<StaffSessionRecord>;
  /**
   * Revoke the session a cookie addresses.
   *
   * Callers must never derive the registry key themselves: the derivation from
   * the cookie secret is private to this store, and reimplementing it outside
   * would let a logout silently miss the row it meant to revoke.
   *
   * @param cookie_value - Raw `<id>.<secret>` cookie value.
   * @returns The revoked record.
   * @throws OAuthFlowError when the cookie is malformed, unknown, or revoked.
   */
  revoke_by_cookie(cookie_value: string): Promise<StaffSessionRecord>;
}

/** In-memory store for a single process. */
export class InMemoryStaffSessionStore implements StaffSessionStore {
  private readonly rows = new Map<string, StaffSessionRecord>();
  private readonly registry = new InMemorySessionRegistry();
  private readonly clock: () => number;

  /**
   * Create the store.
   *
   * @param options - Optional injectable clock.
   */
  constructor(options: { clock?: () => number } = {}) {
    this.clock = options.clock ?? Date.now;
  }

  /**
   * Establish a session for an authenticated principal.
   *
   * @param input - Verified identity, principal, device, and TTL.
   * @returns The stored record and the single cookie value to send.
   * @throws OAuthFlowError when the principal or TTL is unusable.
   */
  async create(input: CreateStaffSessionInput): Promise<EstablishedStaffSession> {
    const ttl_ms = bounded_ttl_ms(input?.ttl_seconds);
    const principal = input?.principal;
    if (principal === undefined || typeof principal.subject_id !== "string" || principal.subject_id.length === 0) {
      throw new OAuthFlowError("oauth_configuration_invalid");
    }
    if (input.subject_id !== principal.subject_id) throw new OAuthFlowError("oauth_identity_unverified");
    if (input.has_mfa !== principal.has_mfa) throw new OAuthFlowError("oauth_identity_unverified");
    const secret = input.secret ?? issue_session_secret();
    const session_id = `${secret.session_id}-${hash_session_secret(secret.secret).slice(0, 16)}`;
    const registry_input: RegisterSessionInput = {
      session_id,
      subject_id: principal.subject_id,
      tenant_id: require_primary_tenant(principal),
      device_id: input.device_id,
      clock: () => new Date(this.clock()),
    };
    const session = register_session(registry_input);
    await this.registry.register({ ...registry_input });
    const record: StaffSessionRecord = {
      session,
      subject_id: principal.subject_id,
      issuer: require_issuer(input.issuer),
      idp: input.idp,
      secret_hash: secret.secret_hash,
      has_mfa: principal.has_mfa,
      tenant_roles: principal.tenant_roles,
      expires_at_ms: this.clock() + ttl_ms,
    };
    this.rows.set(record.session.session_id, record);
    return { record, cookie_value: `${secret.session_id}.${secret.secret}` };
  }

  /**
   * Resolve a cookie value to a live session.
   *
   * @param cookie_value - Raw cookie value from the request.
   * @returns The live session record.
   * @throws OAuthFlowError for unknown, expired, revoked, or mismatched cookies.
   */
  async resolve(cookie_value: string): Promise<StaffSessionRecord> {
    const parsed = parse_session_cookie(cookie_value);
    // The registry key is derived from both halves of the cookie, so an
    // attacker cannot address another session's row with a guessed id.
    const session_id = `${parsed.session_id}-${hash_session_secret(parsed.secret).slice(0, 16)}`;
    const record = this.rows.get(session_id);
    if (record === undefined) throw new OAuthFlowError("oauth_session_unavailable");
    if (this.clock() >= record.expires_at_ms) {
      this.rows.delete(session_id);
      throw new OAuthFlowError("oauth_session_unavailable");
    }
    if (!secret_matches(parsed.secret, record.secret_hash)) {
      throw new OAuthFlowError("oauth_session_unavailable");
    }
    if (is_session_revoked(record.session)) throw new OAuthFlowError("oauth_session_unavailable");
    this.rows.set(session_id, { ...record, session: touch_session(record.session, () => new Date(this.clock())) });
    return record;
  }

  /**
   * Revoke a session so its cookie stops working immediately.
   *
   * The registry's `SessionError` is normalized here so a route handler can map
   * every failure through one sanitized code set; the underlying
   * `session-already-revoked` condition still fails loudly rather than becoming
   * a silent success.
   *
   * @param session_id - Registry session identifier.
   * @returns The revoked record.
   * @throws OAuthFlowError when the session is unknown or already revoked.
   */
  async revoke(session_id: string): Promise<StaffSessionRecord> {
    const record = this.rows.get(session_id);
    if (record === undefined) throw new OAuthFlowError("oauth_session_unavailable");
    let revoked: SessionRecord;
    try {
      revoked = revoke_session(record.session, () => new Date(this.clock()));
    } catch {
      throw new OAuthFlowError("oauth_session_unavailable");
    }
    await this.registry.save(revoked);
    const updated: StaffSessionRecord = { ...record, session: revoked };
    this.rows.set(session_id, updated);
    return updated;
  }

  /**
   * Revoke the session a cookie addresses.
   *
   * @param cookie_value - Raw cookie value from the request.
   * @returns The revoked record.
   * @throws OAuthFlowError when the cookie is malformed, unknown, or revoked.
   */
  async revoke_by_cookie(cookie_value: string): Promise<StaffSessionRecord> {
    const parsed = parse_session_cookie(cookie_value);
    return this.revoke(`${parsed.session_id}-${hash_session_secret(parsed.secret).slice(0, 16)}`);
  }

  /**
   * List the PII-free session history for one subject.
   *
   * @param subject_id - Subject to filter by.
   * @returns Records newest first, never containing secrets.
   */
  async list_subject_sessions(subject_id: string): Promise<StaffSessionRecord[]> {
    return [...this.rows.values()]
      .filter((record) => record.subject_id === subject_id)
      .map((record) => ({ ...record }))
      .sort((left, right) => right.session.last_seen_at_iso.localeCompare(left.session.last_seen_at_iso));
  }
}

/** Hash a device identifier for the audit record, reusing the registry rule. */
export function session_device_hash(device_id: string): string {
  if (typeof device_id !== "string" || device_id.length === 0) throw new OAuthFlowError("oauth_configuration_invalid");
  return hash_device(device_id);
}

/**
 * Project a live session record into the enterprise authorization contract.
 *
 * A session record is not itself an `AuthenticatedPrincipal`, so this is the only
 * supported way to reach `authorize()` / `authorize_privileged()` from a session.
 * Going through `parse_authenticated_principal` is deliberate: it re-validates the
 * tenant ids and roles, so a corrupted or tampered record fails closed instead of
 * reaching the permission table.
 *
 * @param record - Session record resolved from a valid cookie.
 * @returns The principal the authorization contracts accept.
 * @throws OAuthFlowError when the record is revoked or malformed.
 */
export function session_principal(record: StaffSessionRecord): AuthenticatedPrincipal {
  if (is_session_revoked(record.session)) throw new OAuthFlowError("oauth_session_unavailable");
  return parse_authenticated_principal({
    subject_id: record.subject_id,
    tenant_roles: record.tenant_roles as Record<string, EnterpriseRole[]>,
    has_mfa: record.has_mfa,
    session_id: record.session.session_id,
    issued_at_iso: record.session.created_at_iso,
  });
}

/** Validate a TTL in seconds against the session lifetime bounds. */
function bounded_ttl_ms(ttl_seconds: number): number {
  if (
    !Number.isSafeInteger(ttl_seconds) ||
    ttl_seconds < 300 ||
    ttl_seconds > 86_400
  ) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  return ttl_seconds * 1_000;
}

/** The lowest tenant id a principal may act in, used as the registry scope. */
function require_primary_tenant(principal: AuthenticatedPrincipal): string {
  const tenants = Object.keys(principal.tenant_roles).sort();
  const first = tenants[0];
  if (first === undefined) throw new OAuthFlowError("oauth_membership_unresolved");
  return first;
}

/** Validate an issuer string without echoing it. */
function require_issuer(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  return value;
}