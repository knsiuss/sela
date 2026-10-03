/**
 * Fail-closed resolution of which tenants a verified staff identity may act in.
 *
 * A verified ID token proves *who* the caller is. It does not prove what they
 * may do inside this product, and it must not: tenant roles are the IdP's
 * business, while the authoritative role assignment lives here. This module is
 * therefore the single place where a subject becomes an
 * `AuthenticatedPrincipal`, and it refuses to produce one unless the subject has
 * at least one membership whose lifecycle status is `active`.
 *
 * Membership is gated through `is_active_user`, so a suspended or revoked staff
 * member cannot obtain a session and the privileged-action MFA gate keeps its
 * existing meaning. The roles are returned separately from the lifecycle record
 * because `UserRecord` deliberately carries identity state, not authorization.
 *
 * The shipped adapter is environment-backed, which is deployment configuration
 * rather than browser input: it is safe in the same trust class as the client
 * secret. A production deployment replaces it with a database adapter over the
 * existing `user_lifecycle` and `org_hierarchy` contracts; the port exists so
 * that choice is explicit.
 */

import {
  AuthorizationError,
  parse_authenticated_principal,
  type AuthenticatedPrincipal,
  type EnterpriseRole,
} from "../authorization.js";
import {
  is_active_user,
  type UserLifecycleStatus,
  type UserRecord,
} from "../user_lifecycle.js";
import { OAuthFlowError } from "./oauth_error.js";

/** Environment variable carrying the staff membership directory JSON. */
export const STAFF_DIRECTORY_ENV = "STAFF_DIRECTORY_JSON";

const MAX_DIRECTORY_JSON_CHARS = 256 * 1024;
const MAX_DIRECTORY_ENTRIES = 5_000;
const MAX_MEMBERSHIPS_PER_SUBJECT = 50;
const MAX_ISSUER_CHARS = 512;
const MAX_ID_CHARS = 256;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
const ROLES: ReadonlySet<string> = new Set<EnterpriseRole>([
  "owner", "admin", "operator", "support", "analyst", "developer",
]);
const STATUSES: ReadonlySet<string> = new Set<UserLifecycleStatus>([
  "invited", "active", "suspended", "revoked",
]);

/** One tenant membership with the lifecycle record that gates it. */
export interface StaffTenantMembership {
  issuer: string;
  subject_id: string;
  tenant_id: string;
  roles: readonly EnterpriseRole[];
  user: UserRecord;
}

/** Port for membership lookup, keyed by issuer-stable subject. */
export interface StaffDirectory {
  /**
   * List every recorded membership for one subject at one issuer.
   *
   * @param subject_id - Issuer-stable subject from the verified ID token.
   * @param issuer - Normalized token issuer.
   * @returns Memberships in configuration order; empty when unknown.
   */
  list_memberships(subject_id: string, issuer: string): Promise<readonly StaffTenantMembership[]>;
}

/** Membership as configured, before validation. */
interface RawDirectoryEntry {
  issuer?: unknown;
  subject_id?: unknown;
  org_id?: unknown;
  tenant_id?: unknown;
  roles?: unknown;
  status?: unknown;
  invited_at_iso?: unknown;
  activated_at_iso?: unknown;
  updated_at_iso?: unknown;
}

/**
 * Environment-backed staff directory for deployments without a database.
 *
 * @param entries - Already-validated memberships.
 */
export class InMemoryStaffDirectory implements StaffDirectory {
  private readonly by_identity: Map<string, StaffTenantMembership[]>;

  /**
   * Create the directory from validated memberships.
   *
   * @param entries - Memberships to serve; duplicates for one identity collapse.
   */
  constructor(entries: readonly StaffTenantMembership[] = []) {
    this.by_identity = new Map();
    for (const entry of entries) {
      this.add(entry);
    }
  }

  /**
   * List memberships for one subject.
   *
   * @param subject_id - Issuer-stable subject.
   * @param issuer - Normalized issuer.
   * @returns A defensive copy of the recorded memberships.
   */
  async list_memberships(subject_id: string, issuer: string): Promise<readonly StaffTenantMembership[]> {
    const found = this.by_identity.get(directory_key(require_id(subject_id, "subject_id"), issuer));
    return found === undefined ? [] : found.map((membership) => ({ ...membership, roles: [...membership.roles] }));
  }

  /** Index one membership under its issuer-qualified identity. */
  private add(entry: StaffTenantMembership): void {
    const key = directory_key(entry.subject_id, entry.issuer);
    const existing = this.by_identity.get(key);
    if (existing === undefined) this.by_identity.set(key, [entry]);
    else if (existing.length < MAX_MEMBERSHIPS_PER_SUBJECT) existing.push(entry);
  }
}

/**
 * Parse the staff directory JSON from configuration.
 *
 * Expected shape:
 * `{"entries":[{"issuer":"...","subject_id":"...","org_id":"...","tenant_id":"1001",
 * "roles":["owner"],"status":"active","invited_at_iso":"...","updated_at_iso":"..."}]}`
 *
 * An absent value yields an empty directory, which makes every login fail
 * closed with `oauth_membership_unresolved` instead of granting access.
 *
 * @param raw - Raw JSON text from STAFF_DIRECTORY_JSON.
 * @returns A directory serving every validated entry.
 * @throws OAuthFlowError when the JSON or any entry shape is invalid.
 */
export function parse_staff_directory(raw: string | undefined): InMemoryStaffDirectory {
  if (raw === undefined || raw.trim() === "") return new InMemoryStaffDirectory();
  if (raw.length > MAX_DIRECTORY_JSON_CHARS) throw new OAuthFlowError("oauth_configuration_invalid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  if (!is_record(parsed) || !Array.isArray(parsed.entries)) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  if (parsed.entries.length > MAX_DIRECTORY_ENTRIES) throw new OAuthFlowError("oauth_configuration_invalid");
  const entries = parsed.entries.map((entry) => validate_entry(entry));
  return new InMemoryStaffDirectory(entries);
}

/**
 * Turn a verified identity plus its directory into an enterprise principal.
 *
 * @param input - Verified subject, issuer, MFA signal, and issued-at time.
 * @param directory - Membership port to consult.
 * @returns A principal carrying only memberships that are lifecycle-active.
 * @throws OAuthFlowError when the subject has no active membership.
 */
export async function build_staff_principal(
  input: { subject_id: string; issuer: string; has_mfa: boolean; issued_at_iso: string },
  directory: StaffDirectory,
): Promise<AuthenticatedPrincipal> {
  const subject_id = require_id(input?.subject_id, "subject_id");
  const issuer = require_issuer(input?.issuer);
  if (typeof input.has_mfa !== "boolean") throw new OAuthFlowError("oauth_configuration_invalid");
  const memberships = await directory.list_memberships(subject_id, issuer);
  const active = memberships.filter((membership) => is_active_user(membership.user));
  if (active.length === 0) throw new OAuthFlowError("oauth_membership_unresolved");
  const tenant_roles: Record<string, EnterpriseRole[]> = Object.create(null) as Record<string, EnterpriseRole[]>;
  for (const membership of active) {
    const existing = tenant_roles[membership.tenant_id] ?? [];
    tenant_roles[membership.tenant_id] = [...new Set([...existing, ...membership.roles])];
  }
  return parse_authenticated_principal({
    subject_id,
    tenant_roles,
    has_mfa: input.has_mfa,
    session_id: `staff-session-${subject_id}`,
    issued_at_iso: input.issued_at_iso,
  });
}

/**
 * Fail-closed re-check that a principal still carries a tenant scope.
 *
 * @param principal - Principal resolved from a session cookie.
 * @param tenant_id - Tenant the request targets.
 * @throws AuthorizationError when the principal has no membership there.
 */
export function assert_principal_tenant(principal: AuthenticatedPrincipal, tenant_id: string): void {
  const roles = principal.tenant_roles[tenant_id];
  if (roles === undefined || roles.length === 0) throw new AuthorizationError("forbidden");
}

/** Validate one configured membership entry into the directory's shape. */
function validate_entry(entry: unknown): StaffTenantMembership {
  if (!is_record(entry)) throw new OAuthFlowError("oauth_configuration_invalid");
  const raw = entry as RawDirectoryEntry;
  const roles = validate_roles(raw.roles);
  const user = validate_user_record(raw);
  return {
    issuer: require_issuer(raw.issuer),
    subject_id: user.user_id,
    tenant_id: user.tenant_id,
    roles,
    user,
  };
}

/** Validate the role list, refusing unknown or empty role sets. */
function validate_roles(value: unknown): readonly EnterpriseRole[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > ROLES.size) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  for (const role of value) {
    if (typeof role !== "string" || !ROLES.has(role)) throw new OAuthFlowError("oauth_configuration_invalid");
  }
  return Object.freeze([...new Set(value as EnterpriseRole[])]);
}

/** Validate the lifecycle fields into a `UserRecord` for `is_active_user`. */
function validate_user_record(raw: RawDirectoryEntry): UserRecord {
  const status = require_status(raw.status);
  const tenant_id = raw.tenant_id;
  if (typeof tenant_id !== "string" || !/^[1-9]\d{0,18}$/.test(tenant_id)) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  const subject_id = require_id(raw.subject_id, "subject_id");
  require_issuer(raw.issuer);
  const invited_at_iso = require_timestamp(raw.invited_at_iso);
  const updated_at_iso = require_timestamp(raw.updated_at_iso);
  const activated_at_iso = raw.activated_at_iso === undefined || raw.activated_at_iso === null
    ? null
    : require_timestamp(raw.activated_at_iso);
  return {
    user_id: subject_id,
    org_id: require_id(raw.org_id, "org_id"),
    tenant_id,
    status,
    invited_at_iso,
    activated_at_iso,
    suspended_at_iso: status === "suspended" ? updated_at_iso : null,
    revoked_at_iso: status === "revoked" ? updated_at_iso : null,
    updated_at_iso,
  };
}

/** Identity key that keeps two providers' subject namespaces separate. */
function directory_key(subject_id: string, issuer: string): string {
  return `${issuer}|${subject_id}`;
}

/**
 * Validate a lifecycle status against the shared `user_lifecycle` vocabulary.
 *
 * @param value - Untrusted status from configuration.
 * @returns The validated status.
 * @throws OAuthFlowError when the status is not a known lifecycle state.
 */
function require_status(value: unknown): UserLifecycleStatus {
  if (typeof value !== "string" || !STATUSES.has(value)) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  return value as UserLifecycleStatus;
}

/**
 * Validate an opaque identifier such as a subject or org id.
 *
 * @param value - Untrusted identifier from configuration or a token.
 * @param field_name - Field name reported in the failure code only.
 * @returns The validated identifier.
 * @throws OAuthFlowError when the identifier is malformed.
 */
function require_id(value: unknown, field_name: string): string {
  if (typeof value !== "string" || value.length > MAX_ID_CHARS || !ID_PATTERN.test(value)) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  return value;
}

/**
 * Validate a normalized issuer URL.
 *
 * @param value - Untrusted issuer from a token or configuration.
 * @returns The validated issuer without a trailing slash.
 * @throws OAuthFlowError when the issuer is malformed.
 */
function require_issuer(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ISSUER_CHARS) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  const normalized = value.replace(/\/$/u, "");
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  return normalized;
}

/**
 * Validate an ISO timestamp field.
 *
 * @param value - Untrusted timestamp string.
 * @returns The timestamp, normalized through `Date`.
 * @throws OAuthFlowError when the value is not a parseable timestamp.
 */
function require_timestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  return new Date(Date.parse(value)).toISOString();
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}