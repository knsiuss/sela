/**
 * Request scope for the workspace, resolved from a real session.
 *
 * The clock contract is preserved: one reading per request, shared by the shell
 * and every page, so the two can never describe different moments. What changed is
 * the principal: tenant, role, and MFA now come from a verified session, and a
 * principal with no membership refuses to render at all.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  load_workspace_scope,
  resolve_workspace_scope,
  workspace_role,
  workspace_tenant,
} from "../src/app/local_scope";
import {
  AuthorizationError,
  authorize,
  authorize_privileged,
  parse_authenticated_principal,
  type EnterpriseRole,
} from "appointment-agent/dist/src/enterprise/authorization.js";
import { OAuthFlowError } from "appointment-agent/dist/src/enterprise/oauth/index.js";

/** Fixed instant so every assertion is deterministic. */
const FIXED_MS = Date.parse("2026-03-02T09:00:00.000Z");

afterEach(() => {
  vi.restoreAllMocks();
});

/** Build a principal the way a verified session would. */
function principal_for(
  tenant_roles: Record<string, EnterpriseRole[]>,
  has_mfa = false,
): ReturnType<typeof parse_authenticated_principal> {
  return parse_authenticated_principal({
    subject_id: "staff-subject-1",
    tenant_roles,
    has_mfa,
    session_id: "session-1",
    issued_at_iso: "2026-03-02T08:00:00.000Z",
  });
}

describe("resolve_workspace_scope", () => {
  it("builds the snapshot at exactly the reference instant it was given", () => {
    const scope = resolve_workspace_scope(FIXED_MS, principal_for({ "1001": ["operator"] }));
    expect(scope.snapshot.now_iso).toBe(new Date(FIXED_MS).toISOString());
  });

  it("derives the fixtures from the same reading, so nothing is clock-skewed", () => {
    const scope = resolve_workspace_scope(FIXED_MS, principal_for({ "1001": ["operator"] }));
    expect(scope.snapshot.appointments[0]?.starts_at_iso).toBe(new Date(FIXED_MS + 2 * 60 * 60 * 1000).toISOString());
  });

  it("is a pure function of its arguments, so repeat calls agree", () => {
    const principal = principal_for({ "1001": ["operator"] });
    expect(resolve_workspace_scope(FIXED_MS, principal).snapshot.now_iso)
      .toBe(resolve_workspace_scope(FIXED_MS, principal).snapshot.now_iso);
  });

  it("reads the clock nowhere of its own", () => {
    const spy = vi.spyOn(Date, "now");
    resolve_workspace_scope(FIXED_MS, principal_for({ "1001": ["operator"] }));
    expect(spy).not.toHaveBeenCalled();
  });

  it("takes the tenant and role from the session rather than the environment", () => {
    process.env.DASHBOARD_LOCAL_TENANT_ID = "9999";
    const scope = resolve_workspace_scope(FIXED_MS, principal_for({ "2002": ["admin"] }));
    expect(scope.tenant_id).toBe("2002");
    expect(scope.role).toBe("admin");
    expect(Object.keys(scope.principal.tenant_roles)).toEqual(["2002"]);
  });

  it("carries the session's real MFA verdict instead of assuming one", () => {
    expect(resolve_workspace_scope(FIXED_MS, principal_for({ "1001": ["owner"] })).principal.has_mfa).toBe(false);
    expect(resolve_workspace_scope(FIXED_MS, principal_for({ "1001": ["owner"] }, true)).principal.has_mfa).toBe(true);
  });

  it("refuses a principal with no membership instead of rendering unscoped", () => {
    expect(() => resolve_workspace_scope(FIXED_MS, principal_for({}))).toThrowError(OAuthFlowError);
  });

  it("keeps a privileged action closed when the session has no MFA", () => {
    const scope = resolve_workspace_scope(FIXED_MS, principal_for({ "1001": ["owner"] }));
    expect(scope.role).toBe("owner");
    const principal = parse_authenticated_principal(scope.principal);
    expect(() => authorize_privileged(principal, "1001", "outbound:replay")).toThrow(/mfa-required/);
  });
});

describe("workspace tenant and role selection", () => {
  it("picks the lowest tenant id so the scope is deterministic", () => {
    expect(workspace_tenant(principal_for({ "2002": ["admin"], "1001": ["operator"] }))).toBe("1001");
  });

  it("picks the most privileged role for capability hints", () => {
    const principal = principal_for({ "1001": ["support", "owner", "analyst"] });
    expect(workspace_role(principal, "1001")).toBe("owner");
  });

  it("refuses a tenant the principal has no role in", () => {
    const principal = principal_for({ "1001": ["operator"] });
    expect(() => workspace_role(principal, "2002")).toThrowError(OAuthFlowError);
    expect(() => authorize(principal, "2002", "appointments:read")).toThrowError(AuthorizationError);
  });
});

describe("load_workspace_scope", () => {
  it("takes exactly one clock reading per resolution", () => {
    const spy = vi.spyOn(Date, "now");
    load_workspace_scope(principal_for({ "1001": ["operator"] }));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("returns a complete scope for the layout and the pages to share", () => {
    const scope = load_workspace_scope(principal_for({ "1001": ["operator"] }));
    expect(typeof scope.tenant_id).toBe("string");
    expect(typeof scope.role).toBe("string");
    expect(Object.keys(scope.principal.tenant_roles)).toEqual([scope.tenant_id]);
    expect(Number.isNaN(Date.parse(scope.snapshot.now_iso))).toBe(false);
  });
});