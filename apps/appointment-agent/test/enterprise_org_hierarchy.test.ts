import { describe, expect, it } from "vitest";
import { parse_authenticated_principal } from "../src/enterprise/authorization.js";
import {
  assert_user_tenant_membership,
  build_org_hierarchy,
  list_tenant_locations,
  resolve_tenant_org,
  validate_location,
  OrgHierarchyError,
} from "../src/enterprise/org_hierarchy.js";

function principal() {
  return parse_authenticated_principal({
    subject_id: "user-1",
    session_id: "session-1",
    has_mfa: true,
    issued_at_iso: "2026-09-30T00:00:00.000Z",
    tenant_roles: { "42": ["operator"] },
  });
}

describe("org hierarchy", () => {
  it("builds a hierarchy and resolves tenant ownership", () => {
    const hierarchy = build_org_hierarchy("org-1", ["42", "43"]);
    expect(resolve_tenant_org([hierarchy], "43")).toBe("org-1");
    expect(() => resolve_tenant_org([hierarchy], "44")).toThrow(OrgHierarchyError);
  });

  it("rejects duplicate tenants fail-fast", () => {
    expect(() => build_org_hierarchy("org-1", ["42", "42"])).toThrow("org-hierarchy-duplicate-tenant");
  });

  it("validates location bindings against the hierarchy", () => {
    const hierarchy = build_org_hierarchy("org-1", ["42"]);
    const valid = validate_location({ location_id: "loc-1", tenant_id: "42", org_id: "org-1" }, hierarchy);
    expect(valid.location_id).toBe("loc-1");
    expect(() => validate_location({ location_id: "loc-2", tenant_id: "43", org_id: "org-1" }, hierarchy))
      .toThrow("org-location-tenant-unknown");
  });

  it("enforces tenant membership fail-closed", () => {
    expect(() => assert_user_tenant_membership(principal(), "42")).not.toThrow();
    expect(() => assert_user_tenant_membership(principal(), "43")).toThrow("org-tenant-forbidden");
  });

  it("lists locations scoped to one tenant", () => {
    const locations = [
      { location_id: "a", tenant_id: "42", org_id: "org-1" },
      { location_id: "b", tenant_id: "43", org_id: "org-1" },
    ];
    expect(list_tenant_locations(locations, "42")).toHaveLength(1);
  });
});
