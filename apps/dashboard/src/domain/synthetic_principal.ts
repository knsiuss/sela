/**
 * Local synthetic identity scope for the unauthenticated operator dashboard.
 *
 * SECURITY (P2.2, local dev only): nothing in this module authenticates or
 * authorizes anybody. It builds a fixed, obviously-fake principal so the
 * enterprise contracts can be exercised without an identity provider. The
 * tenant and role are resolved on the server from the environment and are
 * never accepted from the browser, so an unauthenticated client cannot widen
 * its own scope by editing a query string.
 */

import {
  parse_authenticated_principal,
  type AuthenticatedPrincipal,
  type EnterpriseRole,
} from "appointment-agent/dist/src/enterprise/authorization.js";

/** Tenant used when no explicit local scope is configured. */
export const DEFAULT_LOCAL_TENANT_ID = "1001";

/** Least-privilege role used when no explicit local role is configured. */
export const DEFAULT_LOCAL_ROLE: EnterpriseRole = "operator";

/** Subject of the local synthetic principal; never a real identity. */
export const LOCAL_OPERATOR_SUBJECT = "local-operator";

/** Session of the local synthetic principal; never a real session. */
export const LOCAL_OPERATOR_SESSION = "local-session";

const TENANT_ID_PATTERN = /^[1-9]\d{0,18}$/;
const ROLES: readonly EnterpriseRole[] = ["owner", "admin", "operator", "support", "analyst", "developer"];

/** Failure raised when the configured local scope is not usable. */
export class LocalScopeError extends Error {
  readonly code: string;

  /** Create a sanitized local-scope failure. */
  constructor(code: string) {
    super(code);
    this.name = "LocalScopeError";
    this.code = code;
  }
}

/**
 * Resolve the tenant this dashboard process is scoped to.
 *
 * @param env - Server environment; never supplied by the browser.
 * @returns A tenant id matching the domain tenant pattern.
 * @throws LocalScopeError When the configured value is malformed.
 */
export function resolve_local_tenant_id(env: Readonly<Record<string, string | undefined>>): string {
  const configured = env["DASHBOARD_LOCAL_TENANT_ID"];
  if (configured === undefined || configured === "") return DEFAULT_LOCAL_TENANT_ID;
  if (!TENANT_ID_PATTERN.test(configured)) throw new LocalScopeError("dashboard-local-tenant-invalid");
  return configured;
}

/**
 * Resolve the role the local synthetic principal is granted.
 *
 * @param env - Server environment; never supplied by the browser.
 * @returns One of the enterprise roles, defaulting to the least privileged.
 * @throws LocalScopeError When the configured value is not a known role.
 */
export function resolve_local_role(env: Readonly<Record<string, string | undefined>>): EnterpriseRole {
  const configured = env["DASHBOARD_LOCAL_ROLE"];
  if (configured === undefined || configured === "") return DEFAULT_LOCAL_ROLE;
  if (!ROLES.includes(configured as EnterpriseRole)) throw new LocalScopeError("dashboard-local-role-invalid");
  return configured as EnterpriseRole;
}

/**
 * Build the synthetic principal used for local, unauthenticated rendering.
 *
 * @param tenant_id - Tenant the principal is scoped to.
 * @param role - Role granted inside that tenant.
 * @returns Claims normalized by the real authorization contract.
 */
export function build_local_principal(tenant_id: string, role: EnterpriseRole): AuthenticatedPrincipal {
  if (!TENANT_ID_PATTERN.test(tenant_id)) throw new LocalScopeError("dashboard-local-tenant-invalid");
  if (!ROLES.includes(role)) throw new LocalScopeError("dashboard-local-role-invalid");
  return parse_authenticated_principal({
    subject_id: LOCAL_OPERATOR_SUBJECT,
    tenant_roles: { [tenant_id]: [role] },
    has_mfa: true,
    session_id: LOCAL_OPERATOR_SESSION,
    issued_at_iso: "2026-01-01T00:00:00.000Z",
  });
}

/** Plain, serializable form of the synthetic claims. */
export interface LocalPrincipalClaims {
  subject_id: string;
  tenant_roles: Record<string, EnterpriseRole[]>;
  has_mfa: boolean;
  session_id: string;
  issued_at_iso: string;
}

/**
 * Copy validated claims into a plain object safe for the RSC boundary.
 *
 * `parse_authenticated_principal` deliberately builds `tenant_roles` with a
 * null prototype, which React refuses to serialize from a Server Component to
 * a Client Component. This projection restores ordinary prototypes without
 * changing any value; the client re-validates through the same contract.
 *
 * @param principal - Claims produced by the real authorization contract.
 * @returns Claims with plain objects and arrays.
 */
export function to_wire_principal(principal: AuthenticatedPrincipal): LocalPrincipalClaims {
  const tenant_roles: Record<string, EnterpriseRole[]> = {};
  for (const [tenant_id, roles] of Object.entries(principal.tenant_roles)) {
    tenant_roles[tenant_id] = [...roles];
  }
  return {
    subject_id: principal.subject_id,
    tenant_roles,
    has_mfa: principal.has_mfa,
    session_id: principal.session_id,
    issued_at_iso: principal.issued_at_iso,
  };
}