/** Fail-closed enterprise authorization contracts for operator and API surfaces. */

/** Roles recognized by the enterprise control plane. */
export type EnterpriseRole = "owner" | "admin" | "operator" | "support" | "analyst" | "developer";

/** Explicit permissions checked at every privileged boundary. */
export type EnterprisePermission =
  | "appointments:read"
  | "appointments:reschedule"
  | "appointments:cancel"
  | "handoff:read"
  | "outbound:replay"
  | "outbound:status:read"
  | "tenant:manage"
  | "audit:read"
  | "analytics:read";

/** Claims materialized only after an external identity verifier succeeds. */
export interface AuthenticatedPrincipal {
  subject_id: string;
  tenant_roles: Readonly<Record<string, readonly EnterpriseRole[]>>;
  has_mfa: boolean;
  session_id: string;
  issued_at_iso: string;
}

/** Port implemented by an OIDC/SAML gateway; no unsafe token parser lives here. */
export interface OidcIdentityVerifier {
  /** Verify a bearer token and return normalized, tenant-scoped claims. */
  verify(access_token: string): Promise<AuthenticatedPrincipal>;
}

/** Authorization failure with a stable HTTP-facing category. */
export class AuthorizationError extends Error {
  readonly code: "unauthenticated" | "forbidden" | "mfa_required";

  /** Create a sanitized authorization error. */
  constructor(code: AuthorizationError["code"]) {
    super(`authorization-${code.replace("_", "-")}`);
    this.name = "AuthorizationError";
    this.code = code;
  }
}

const ROLE_PERMISSIONS: Readonly<Record<EnterpriseRole, readonly EnterprisePermission[]>> = Object.freeze({
  owner: [
    "appointments:read", "appointments:reschedule", "appointments:cancel", "handoff:read",
    "outbound:replay", "outbound:status:read", "tenant:manage", "audit:read", "analytics:read",
  ],
  admin: [
    "appointments:read", "appointments:reschedule", "appointments:cancel", "handoff:read",
    "outbound:replay", "outbound:status:read", "audit:read", "analytics:read",
  ],
  operator: ["appointments:read", "appointments:reschedule", "handoff:read", "outbound:status:read"],
  support: ["appointments:read", "handoff:read"],
  analyst: ["appointments:read", "analytics:read"],
  developer: ["appointments:read", "outbound:status:read", "analytics:read"],
});

/** Validate and copy claims before they cross an API boundary. */
export function parse_authenticated_principal(value: unknown): AuthenticatedPrincipal {
  if (!is_record(value) || typeof value.subject_id !== "string" || !safe_id(value.subject_id)) {
    throw new AuthorizationError("unauthenticated");
  }
  if (typeof value.session_id !== "string" || !safe_id(value.session_id)) {
    throw new AuthorizationError("unauthenticated");
  }
  if (typeof value.has_mfa !== "boolean") throw new AuthorizationError("unauthenticated");
  if (typeof value.issued_at_iso !== "string" || !Number.isFinite(Date.parse(value.issued_at_iso))) {
    throw new AuthorizationError("unauthenticated");
  }
  if (!is_record(value.tenant_roles)) throw new AuthorizationError("unauthenticated");
  const tenant_roles: Record<string, readonly EnterpriseRole[]> = Object.create(null) as Record<string, readonly EnterpriseRole[]>;
  for (const [tenant_id, raw_roles] of Object.entries(value.tenant_roles)) {
    if (!/^[1-9]\d{0,18}$/.test(tenant_id) || !Array.isArray(raw_roles)) throw new AuthorizationError("unauthenticated");
    const roles = [...new Set(raw_roles)];
    if (roles.length === 0 || roles.some((role) => !is_role(role))) throw new AuthorizationError("unauthenticated");
    tenant_roles[tenant_id] = Object.freeze(roles) as readonly EnterpriseRole[];
  }
  return Object.freeze({
    subject_id: value.subject_id,
    tenant_roles: Object.freeze(tenant_roles),
    has_mfa: value.has_mfa,
    session_id: value.session_id,
    issued_at_iso: new Date(Date.parse(value.issued_at_iso)).toISOString(),
  });
}

/** Require a tenant membership and permission; absent membership is forbidden. */
export function authorize(
  principal: AuthenticatedPrincipal,
  tenant_id: string,
  permission: EnterprisePermission,
): void {
  const normalized = parse_authenticated_principal(principal);
  if (!/^[1-9]\d{0,18}$/.test(tenant_id)) throw new AuthorizationError("forbidden");
  const roles = normalized.tenant_roles[tenant_id] ?? [];
  const allowed = roles.some((role) => ROLE_PERMISSIONS[role].includes(permission));
  if (!allowed) throw new AuthorizationError("forbidden");
}

/** Permissions that additionally require a verified second factor. */
const MFA_GATED_PERMISSIONS: ReadonlySet<EnterprisePermission> = new Set<EnterprisePermission>([
  "outbound:replay",
  "appointments:cancel",
  "tenant:manage",
]);

/**
 * Report whether a permission is second-factor gated.
 *
 * This is the single definition of the gate, so a caller cannot route a
 * permission through the non-privileged path by classifying the *action* rather
 * than the permission it maps to.
 *
 * @param permission - Permission the authorization contract would check.
 * @returns True when `authorize_privileged` demands verified MFA for it.
 */
export function permission_requires_mfa(permission: EnterprisePermission): boolean {
  return MFA_GATED_PERMISSIONS.has(permission);
}

/** Require MFA for replay, cancellation, and tenant-management actions. */
export function authorize_privileged(
  principal: AuthenticatedPrincipal,
  tenant_id: string,
  permission: EnterprisePermission,
): void {
  authorize(principal, tenant_id, permission);
  if (permission_requires_mfa(permission) && !principal.has_mfa) {
    throw new AuthorizationError("mfa_required");
  }
}

/** Return true when a role grants a permission, useful for UI capability hints. */
export function role_has_permission(role: EnterpriseRole, permission: EnterprisePermission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** Map the original memberships vocabulary without granting extra privileges. */
export function map_legacy_role(role: "owner" | "staff" | "viewer"): EnterpriseRole {
  if (role === "owner") return "owner";
  if (role === "staff") return "operator";
  return "analyst";
}

/** Reject an absent OIDC verifier rather than accepting unverified claims. */
export function require_oidc_verifier(value: OidcIdentityVerifier | undefined): OidcIdentityVerifier {
  if (value === undefined || typeof value.verify !== "function") {
    throw new AuthorizationError("unauthenticated");
  }
  return value;
}

function is_role(value: unknown): value is EnterpriseRole {
  return value === "owner" || value === "admin" || value === "operator" || value === "support" || value === "analyst" || value === "developer";
}

function safe_id(value: string): boolean {
  return value.length > 0 && value.length <= 256 && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
