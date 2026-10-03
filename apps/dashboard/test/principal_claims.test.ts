/**
 * The principal boundary now has exactly one production source: a verified
 * session. These tests cover the two halves of that boundary.
 *
 * `principal_claims` must stay a pure serialization layer, and the fixture
 * builder must no longer be able to assert MFA on its own — the previous
 * synthetic principal hard-coded `has_mfa: true`, so a privileged action passed
 * the MFA gate with no second factor anywhere in the system.
 */

import { describe, expect, it } from "vitest";
import {
  AuthorizationError,
  authorize,
  authorize_privileged,
} from "appointment-agent/dist/src/enterprise/authorization.js";
import { to_wire_principal, from_wire_principal } from "../src/domain/principal_claims.js";
import {
  FIXTURE_SUBJECT,
  FixturePrincipalError,
  build_fixture_claims,
  build_fixture_principal,
} from "./support/fixture_principal.js";

describe("to_wire_principal", () => {
  it("produces plain objects that survive the server-to-client boundary", () => {
    const wire = to_wire_principal(build_fixture_principal("1001", "operator"));
    expect(Object.getPrototypeOf(wire)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(wire.tenant_roles)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(wire.tenant_roles["1001"])).toBe(Array.prototype);
  });

  it("preserves every claim value without adding or dropping anything", () => {
    const principal = build_fixture_principal("1001", "admin", true);
    const wire = to_wire_principal(principal);
    expect(wire.subject_id).toBe(principal.subject_id);
    expect(wire.has_mfa).toBe(principal.has_mfa);
    expect(wire.session_id).toBe(principal.session_id);
    expect(wire.issued_at_iso).toBe(principal.issued_at_iso);
    expect(wire.tenant_roles).toEqual({ "1001": ["admin"] });
  });

  it("round-trips through the real contract without widening anything", () => {
    const wire = build_fixture_claims("1001", "operator");
    const principal = from_wire_principal(wire);
    expect(() => authorize(principal, "1001", "appointments:read")).not.toThrow();
    expect(() => authorize(principal, "2002", "appointments:read")).toThrowError(AuthorizationError);
  });

  it("rejects wire claims that are not a valid principal", () => {
    expect(() => from_wire_principal({ tenant_roles: { "0": ["owner"] } } as never)).toThrowError(AuthorizationError);
    expect(() => from_wire_principal({ has_mfa: "yes" } as never)).toThrowError(AuthorizationError);
  });
});

describe("fixture principal", () => {
  it("is not a real identity and carries no membership elsewhere", () => {
    const principal = build_fixture_principal("1001", "operator");
    expect(principal.subject_id).toBe(FIXTURE_SUBJECT);
    expect(() => authorize(principal, "2002", "appointments:read")).toThrowError(AuthorizationError);
  });

  it("reports MFA as unverified unless a test asks for it explicitly", () => {
    expect(build_fixture_principal("1001", "owner").has_mfa).toBe(false);
    expect(build_fixture_principal("1001", "owner").has_mfa).toBe(false);
  });

  it("fails closed on a privileged action unless the test simulates a second factor", () => {
    const unverified = build_fixture_principal("1001", "owner");
    expect(() => authorize_privileged(unverified, "1001", "outbound:replay")).toThrow(/mfa-required/);
    const verified = build_fixture_principal("1001", "owner", true);
    expect(() => authorize_privileged(verified, "1001", "outbound:replay")).not.toThrow();
  });

  it("still refuses a malformed tenant id", () => {
    expect(() => build_fixture_principal("0", "operator")).toThrowError(FixturePrincipalError);
    expect(() => build_fixture_principal("1001", "superuser" as never)).toThrowError(FixturePrincipalError);
  });
});