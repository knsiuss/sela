import { describe, expect, it } from "vitest";
import {
  authorize,
  authorize_privileged,
  AuthorizationError,
  parse_authenticated_principal,
} from "../src/enterprise/authorization.js";

function principal(overrides: Record<string, unknown> = {}) {
  return parse_authenticated_principal({
    subject_id: "operator-subject",
    session_id: "session-1",
    has_mfa: true,
    issued_at_iso: "2026-09-25T00:00:00.000Z",
    tenant_roles: { "42": ["operator"] },
    ...overrides,
  });
}

describe("enterprise authorization", () => {
  it("enforces tenant membership and least-privilege permissions", () => {
    const operator = principal();
    expect(() => authorize(operator, "42", "appointments:read")).not.toThrow();
    expect(() => authorize(operator, "43", "appointments:read")).toThrow(AuthorizationError);
    expect(() => authorize(operator, "42", "tenant:manage")).toThrow(AuthorizationError);
  });

  it("returns immutable role maps at the authorization boundary", () => {
    const parsed = principal();
    expect(Object.isFrozen(parsed.tenant_roles)).toBe(true);
    expect(Object.isFrozen(parsed.tenant_roles["42"])).toBe(true);
    expect(Object.getPrototypeOf(parsed.tenant_roles)).toBeNull();
  });

  it("requires MFA for privileged replay and cancellation actions", () => {
    const without_mfa = principal({ has_mfa: false, tenant_roles: { "42": ["admin"] } });
    expect(() => authorize_privileged(without_mfa, "42", "outbound:replay")).toThrow(AuthorizationError);
    expect(() => authorize_privileged(principal({ tenant_roles: { "42": ["admin"] } }), "42", "outbound:replay"))
      .not.toThrow();
  });

  it("rejects unverified or malformed claims", () => {
    expect(() => parse_authenticated_principal({ subject_id: "x" })).toThrow(AuthorizationError);
    expect(() => parse_authenticated_principal({
      subject_id: "x",
      session_id: "s",
      has_mfa: false,
      issued_at_iso: "not-a-date",
      tenant_roles: { "42": ["owner"] },
    })).toThrow(AuthorizationError);
  });
});
