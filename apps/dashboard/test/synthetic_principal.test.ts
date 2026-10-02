import { describe, expect, it } from "vitest";
import { AuthorizationError, authorize } from "appointment-agent/dist/src/enterprise/authorization.js";
import {
  build_local_principal,
  DEFAULT_LOCAL_ROLE,
  DEFAULT_LOCAL_TENANT_ID,
  LocalScopeError,
  resolve_local_role,
  resolve_local_tenant_id,
  to_wire_principal,
} from "../src/domain/synthetic_principal.js";

describe("resolve_local_tenant_id", () => {
  it("falls back to the default tenant when the environment is empty", () => {
    expect(resolve_local_tenant_id({})).toBe(DEFAULT_LOCAL_TENANT_ID);
  });

  it("returns the configured tenant when it matches the domain pattern", () => {
    expect(resolve_local_tenant_id({ DASHBOARD_LOCAL_TENANT_ID: "2002" })).toBe("2002");
  });

  it("rejects a configured tenant that the domain would refuse", () => {
    expect(() => resolve_local_tenant_id({ DASHBOARD_LOCAL_TENANT_ID: "tenant-a" }))
      .toThrowError(new LocalScopeError("dashboard-local-tenant-invalid"));
  });
});

describe("resolve_local_role", () => {
  it("defaults to the least privileged role", () => {
    expect(resolve_local_role({})).toBe(DEFAULT_LOCAL_ROLE);
  });

  it("accepts a known enterprise role", () => {
    expect(resolve_local_role({ DASHBOARD_LOCAL_ROLE: "owner" })).toBe("owner");
  });

  it("rejects an unknown role instead of silently downgrading", () => {
    expect(() => resolve_local_role({ DASHBOARD_LOCAL_ROLE: "superuser" }))
      .toThrowError(new LocalScopeError("dashboard-local-role-invalid"));
  });
});

describe("build_local_principal", () => {
  it("produces claims the real authorization contract accepts for the tenant", () => {
    const principal = build_local_principal("1001", "operator");
    expect(() => authorize(principal, "1001", "appointments:read")).not.toThrow();
  });

  it("carries no membership in any other tenant", () => {
    const principal = build_local_principal("1001", "owner");
    expect(() => authorize(principal, "2002", "appointments:read")).toThrowError(AuthorizationError);
  });

  it("rejects a malformed tenant id", () => {
    expect(() => build_local_principal("0", "operator")).toThrowError(LocalScopeError);
  });
});

describe("to_wire_principal", () => {
  it("produces plain objects that survive the server-to-client boundary", () => {
    const wire = to_wire_principal(build_local_principal("1001", "operator"));
    expect(Object.getPrototypeOf(wire)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(wire.tenant_roles)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(wire.tenant_roles["1001"])).toBe(Array.prototype);
  });

  it("preserves every claim value", () => {
    const principal = build_local_principal("1001", "admin");
    const wire = to_wire_principal(principal);
    expect(wire.subject_id).toBe(principal.subject_id);
    expect(wire.has_mfa).toBe(principal.has_mfa);
    expect(wire.tenant_roles).toEqual({ "1001": ["admin"] });
  });
});