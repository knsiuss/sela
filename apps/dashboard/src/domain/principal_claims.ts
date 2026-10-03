/**
 * Serialization boundary for the authenticated principal.
 *
 * `parse_authenticated_principal` deliberately builds `tenant_roles` with a null
 * prototype, which React refuses to serialize from a Server Component to a
 * Client Component. This module restores ordinary prototypes without changing a
 * single value, so the claims a client component receives are the claims the
 * server verified, and the client re-validates them through the real contract.
 *
 * There is no way to construct claims here. Claims originate only from a verified
 * ID token plus a directory lookup on the server, which is what keeps the removed
 * synthetic principal from creeping back in.
 */

import {
  parse_authenticated_principal,
  type AuthenticatedPrincipal,
  type EnterpriseRole,
} from "appointment-agent/dist/src/enterprise/authorization.js";

/** Plain, serializable form of verified claims. */
export interface PrincipalClaims {
  subject_id: string;
  tenant_roles: Record<string, EnterpriseRole[]>;
  /** True only when an identity provider asserted a second factor. */
  has_mfa: boolean;
  session_id: string;
  issued_at_iso: string;
}

/**
 * Copy verified claims into a plain object safe for the RSC boundary.
 *
 * @param principal - Claims produced by the real authorization contract.
 * @returns Claims with plain objects and arrays.
 */
export function to_wire_principal(principal: AuthenticatedPrincipal): PrincipalClaims {
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

/**
 * Re-validate wire claims through the real contract.
 *
 * @param claims - Claims received by a client component.
 * @returns A normalized principal.
 * @throws AuthorizationError when the claims are not a valid principal.
 */
export function from_wire_principal(claims: PrincipalClaims): AuthenticatedPrincipal {
  return parse_authenticated_principal(claims);
}