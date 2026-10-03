/**
 * Test-only principal fixture.
 *
 * This lives under `test/` because production must have exactly one way to obtain
 * a principal: a verified ID token plus a directory lookup. The previous
 * `src/domain/synthetic_principal.ts` was importable from application code and
 * hard-coded `has_mfa: true`, which meant a privileged action could pass the MFA
 * gate with no second factor anywhere in the system.
 *
 * `has_mfa` is now an explicit parameter that defaults to `false`, so a test that
 * wants to exercise a privileged action has to say out loud that it is simulating
 * a second factor, and a test that forgets gets the fail-closed behaviour.
 */

import {
  parse_authenticated_principal,
  type AuthenticatedPrincipal,
  type EnterpriseRole,
} from "appointment-agent/dist/src/enterprise/authorization.js";
import { to_wire_principal, type PrincipalClaims } from "../../src/domain/principal_claims.js";

/** Subject of a fixture principal; never a real identity. */
export const FIXTURE_SUBJECT = "fixture-operator";

/** Session of a fixture principal; never a real session. */
export const FIXTURE_SESSION = "fixture-session";

/** Failure raised when a fixture principal is asked for something invalid. */
export class FixturePrincipalError extends Error {
  /** Stable machine-readable code. */
  readonly code: string;

  /** Create a sanitized fixture failure. */
  constructor(code: string) {
    super(code);
    this.name = "FixturePrincipalError";
    this.code = code;
  }
}

const TENANT_ID_PATTERN = /^[1-9]\d{0,18}$/;
const ROLES: readonly EnterpriseRole[] = ["owner", "admin", "operator", "support", "analyst", "developer"];

/**
 * Build a fixture principal for rendering and preflight tests.
 *
 * @param tenant_id - Tenant the fixture is scoped to.
 * @param role - Role granted inside that tenant.
 * @param has_mfa - Whether to simulate a verified second factor; defaults to false.
 * @returns Claims normalized by the real authorization contract.
 * @throws FixturePrincipalError when the tenant or role is invalid.
 */
export function build_fixture_principal(
  tenant_id: string,
  role: EnterpriseRole,
  has_mfa = false,
): AuthenticatedPrincipal {
  if (!TENANT_ID_PATTERN.test(tenant_id)) throw new FixturePrincipalError("fixture-tenant-invalid");
  if (!ROLES.includes(role)) throw new FixturePrincipalError("fixture-role-invalid");
  return parse_authenticated_principal({
    subject_id: FIXTURE_SUBJECT,
    tenant_roles: { [tenant_id]: [role] },
    has_mfa,
    session_id: FIXTURE_SESSION,
    issued_at_iso: "2026-01-01T00:00:00.000Z",
  });
}

/**
 * Build serializable fixture claims for a client component.
 *
 * @param tenant_id - Tenant the fixture is scoped to.
 * @param role - Role granted inside that tenant.
 * @param has_mfa - Whether to simulate a verified second factor; defaults to false.
 * @returns Wire claims for a rendered workspace.
 */
export function build_fixture_claims(
  tenant_id: string,
  role: EnterpriseRole,
  has_mfa = false,
): PrincipalClaims {
  return to_wire_principal(build_fixture_principal(tenant_id, role, has_mfa));
}