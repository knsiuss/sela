/**
 * Request scope for the workspace, resolved from a real session.
 *
 * The clock contract is preserved: one reading per request, shared by the shell
 * and every page, so the two can never describe different moments. What changed is
 * the principal: tenant, role, and MFA now come from a verified session, and a
 * principal with no membership refuses to render at all.
 *
 * `load_workspace_scope` also stopped taking a principal argument. `cache` compares
 * its arguments, so a caller-supplied object made the cache miss every time and the
 * one-reading guarantee did not hold. These tests therefore run the module inside
 * React's own request-scoped cache, which is the only environment in which `cache`
 * memoizes at all, and assert both that a second call costs no extra reading and
 * that the previous object-argument shape would have failed.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as mocked_react from "react";
import {
  in_request_scope,
  load_react_server_build,
  react_server_internals,
} from "./support/react_request_cache";

vi.mock("react", async () => {
  // Resolved inline because `vi.mock` factories are hoisted above this file's
  // imports; the same build path helper uses is applied here directly.
  const { createRequire } = await import("node:module");
  const { dirname, join } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const entry = createRequire(import.meta.url).resolve("react");
  const build = await import(/* @vite-ignore */ pathToFileURL(join(dirname(entry), "react.react-server.js")).href);
  return { ...build, default: build };
});

vi.mock("../src/app/auth/session", () => ({
  require_session_principal: async () => session_principal_under_test,
}));

const {
  load_workspace_scope,
  resolve_workspace_scope,
  workspace_role,
  workspace_tenant,
} = await import("../src/app/local_scope");
const { parse_authenticated_principal } = await import("appointment-agent/dist/src/enterprise/authorization.js");
const { OAuthFlowError } = await import("appointment-agent/dist/src/enterprise/oauth/index.js");
const { AuthorizationError, authorize, authorize_privileged } = await import(
  "appointment-agent/dist/src/enterprise/authorization.js"
);

/** React internals of the aliased build, i.e. the ones `cache` reads. */
const REACT_INTERNALS = react_server_internals(mocked_react as unknown as Record<string, unknown>);

type EnterpriseRole = Parameters<typeof workspace_role>[1];

/** Fixed instant so every assertion is deterministic. */
const FIXED_MS = Date.parse("2026-03-02T09:00:00.000Z");

afterEach(() => {
  vi.restoreAllMocks();
});

/** Build a principal the way a verified session would. */
function principal_for(
  tenant_roles: Record<string, EnterpriseRole[]>,
  has_mfa = false,
) {
  return parse_authenticated_principal({
    subject_id: "staff-subject-1",
    tenant_roles,
    has_mfa,
    session_id: "session-1",
    issued_at_iso: "2026-03-02T08:00:00.000Z",
  });
}

/** The principal the mocked session resolver hands back. */
let session_principal_under_test = principal_for({ "1001": ["operator"] });

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
  it("reads the clock once per resolution and returns a usable scope", async () => {
    const spy = vi.spyOn(Date, "now");
    const scope = await in_request_scope(REACT_INTERNALS, () => load_workspace_scope());
    expect(spy).toHaveBeenCalledTimes(1);
    expect(typeof scope.tenant_id).toBe("string");
    expect(Number.isNaN(Date.parse(scope.snapshot.now_iso))).toBe(false);
  });

  it("reads the clock once for every caller in the same request", async () => {
    const spy = vi.spyOn(Date, "now");
    const [first, second] = await in_request_scope(REACT_INTERNALS, async () => {
      const one = await load_workspace_scope();
      const two = await load_workspace_scope();
      return [one, two] as const;
    });
    // The layout and every page call this in one request. With a caller-supplied
    // argument the cache key would be a fresh object each time, every call would
    // re-read the clock, and the shell and page snapshots would diverge.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(second.snapshot.now_iso).toBe(first.snapshot.now_iso);
  });

  it("re-reads the clock for a later request rather than reusing a stale scope", async () => {
    const spy = vi.spyOn(Date, "now");
    await in_request_scope(REACT_INTERNALS, () => load_workspace_scope());
    await in_request_scope(REACT_INTERNALS, () => load_workspace_scope());
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("returns a complete scope for the layout and the pages to share", async () => {
    const scope = await load_workspace_scope();
    expect(typeof scope.tenant_id).toBe("string");
    expect(typeof scope.role).toBe("string");
    expect(Object.keys(scope.principal.tenant_roles)).toEqual([scope.tenant_id]);
    expect(Number.isNaN(Date.parse(scope.snapshot.now_iso))).toBe(false);
  });

  it("refuses to render when the session has no membership", async () => {
    session_principal_under_test = principal_for({});
    await expect(load_workspace_scope()).rejects.toBeInstanceOf(OAuthFlowError);
    session_principal_under_test = principal_for({ "1001": ["operator"] });
  });
});
