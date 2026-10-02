/**
 * Single-resolution contract for the local scope.
 *
 * The layout and every page render inside one request. Reading the clock once
 * per request is what keeps the shell snapshot and the page snapshot from
 * describing two different moments, so the resolver takes its reference time as
 * an argument and the memoised loader is what performs the single read.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { load_local_scope, resolve_local_scope } from "../src/app/local_scope";
import { DEFAULT_LOCAL_ROLE, DEFAULT_LOCAL_TENANT_ID } from "../src/domain/synthetic_principal";

/** Fixed instant so every assertion is deterministic. */
const FIXED_MS = Date.parse("2026-03-02T09:00:00.000Z");

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("resolve_local_scope", () => {
  it("builds the snapshot at exactly the reference instant it was given", () => {
    const scope = resolve_local_scope(FIXED_MS);
    expect(scope.snapshot.now_iso).toBe(new Date(FIXED_MS).toISOString());
  });

  it("derives the fixtures from the same reading, so nothing is clock-skewed", () => {
    const scope = resolve_local_scope(FIXED_MS);
    const first = scope.snapshot.appointments[0];
    expect(first.starts_at_iso).toBe(new Date(FIXED_MS + 2 * 60 * 60 * 1000).toISOString());
  });

  it("is a pure function of its argument, so repeat calls agree", () => {
    expect(resolve_local_scope(FIXED_MS).snapshot.now_iso).toBe(resolve_local_scope(FIXED_MS).snapshot.now_iso);
  });

  it("reads the clock nowhere of its own", () => {
    const spy = vi.spyOn(Date, "now");
    resolve_local_scope(FIXED_MS);
    expect(spy).not.toHaveBeenCalled();
  });

  it("resolves the tenant and role from the environment", () => {
    process.env.DASHBOARD_LOCAL_TENANT_ID = DEFAULT_LOCAL_TENANT_ID;
    process.env.DASHBOARD_LOCAL_ROLE = DEFAULT_LOCAL_ROLE;
    const scope = resolve_local_scope(FIXED_MS);
    expect(scope.tenant_id).toBe(DEFAULT_LOCAL_TENANT_ID);
    expect(scope.role).toBe(DEFAULT_LOCAL_ROLE);
    expect(Object.keys(scope.principal.tenant_roles)).toEqual([DEFAULT_LOCAL_TENANT_ID]);
  });

  it("still refuses a malformed tenant instead of rendering an unscoped view", () => {
    process.env.DASHBOARD_LOCAL_TENANT_ID = "not-a-tenant";
    expect(() => resolve_local_scope(FIXED_MS)).toThrow();
  });
});

describe("load_local_scope", () => {
  it("takes exactly one clock reading per resolution", () => {
    const spy = vi.spyOn(Date, "now");
    load_local_scope();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("returns a complete scope for the layout and the pages to share", () => {
    const scope = load_local_scope();
    expect(typeof scope.tenant_id).toBe("string");
    expect(typeof scope.role).toBe("string");
    expect(Object.keys(scope.principal.tenant_roles)).toEqual([scope.tenant_id]);
    expect(Number.isNaN(Date.parse(scope.snapshot.now_iso))).toBe(false);
  });
});