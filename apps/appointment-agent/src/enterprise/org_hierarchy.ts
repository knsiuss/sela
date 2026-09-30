/** Organization to tenant to location hierarchy with fail-closed checks. */

import type { AuthenticatedPrincipal } from "./authorization.js";

/** One organization with its tenant members. */
export interface OrgHierarchy {
  org_id: string;
  tenant_ids: readonly string[];
}

/** One physical or logical location bound to a tenant and org. */
export interface LocationNode {
  location_id: string;
  tenant_id: string;
  org_id: string;
}

/** Failure with a stable machine-readable code. */
export class OrgHierarchyError extends Error {
  readonly code: string;

  /** Create a sanitized hierarchy failure. */
  constructor(code: string) {
    super(code);
    this.name = "OrgHierarchyError";
    this.code = code;
  }
}

/**
 * Build an org hierarchy from explicit tenant members.
 *
 * @param org_id - Organization identifier.
 * @param tenant_ids - Tenant members, deduplicated.
 * @returns Frozen hierarchy node.
 */
export function build_org_hierarchy(org_id: string, tenant_ids: readonly string[]): OrgHierarchy {
  require_safe_id(org_id);
  if (!Array.isArray(tenant_ids) || tenant_ids.length === 0 || tenant_ids.length > 1_000) {
    throw new OrgHierarchyError("org-hierarchy-tenants-invalid");
  }
  const unique = [...new Set(tenant_ids)];
  if (unique.length !== tenant_ids.length) throw new OrgHierarchyError("org-hierarchy-duplicate-tenant");
  for (const tenant_id of unique) require_tenant_id(tenant_id);
  return Object.freeze({ org_id, tenant_ids: Object.freeze(unique) });
}

/**
 * Validate a location node against its declared org and tenant.
 *
 * @param node - Location binding to validate.
 * @param hierarchy - Owning org hierarchy.
 * @returns The validated node.
 */
export function validate_location(node: LocationNode, hierarchy: OrgHierarchy): LocationNode {
  if (typeof node !== "object" || node === null) throw new OrgHierarchyError("org-location-invalid");
  require_safe_id(node.location_id);
  require_tenant_id(node.tenant_id);
  require_safe_id(node.org_id);
  if (node.org_id !== hierarchy.org_id) throw new OrgHierarchyError("org-location-org-mismatch");
  if (!hierarchy.tenant_ids.includes(node.tenant_id)) throw new OrgHierarchyError("org-location-tenant-unknown");
  return { ...node };
}

/**
 * Resolve the owning org for a tenant.
 *
 * @param hierarchies - All known org hierarchies.
 * @param tenant_id - Tenant to resolve.
 * @returns The owning org id.
 */
export function resolve_tenant_org(hierarchies: readonly OrgHierarchy[], tenant_id: string): string {
  require_tenant_id(tenant_id);
  if (!Array.isArray(hierarchies)) throw new OrgHierarchyError("org-hierarchy-invalid");
  for (const hierarchy of hierarchies) {
    if (hierarchy.tenant_ids.includes(tenant_id)) return hierarchy.org_id;
  }
  throw new OrgHierarchyError("org-tenant-unknown");
}

/**
 * Require principal membership in a tenant.
 *
 * @param principal - Verified principal.
 * @param tenant_id - Tenant being accessed.
 */
export function assert_user_tenant_membership(principal: AuthenticatedPrincipal, tenant_id: string): void {
  require_tenant_id(tenant_id);
  const roles = principal.tenant_roles?.[tenant_id];
  if (!Array.isArray(roles) || roles.length === 0) throw new OrgHierarchyError("org-tenant-forbidden");
}

/**
 * List locations for one tenant.
 *
 * @param locations - Candidate locations.
 * @param tenant_id - Tenant filter.
 * @returns Copies scoped to the tenant.
 */
export function list_tenant_locations(locations: readonly LocationNode[], tenant_id: string): LocationNode[] {
  require_tenant_id(tenant_id);
  if (!Array.isArray(locations)) throw new OrgHierarchyError("org-locations-invalid");
  return locations.filter((node) => node.tenant_id === tenant_id).map((node) => ({ ...node }));
}

function require_tenant_id(value: string): string {
  if (typeof value !== "string" || !/^[1-9]\d{0,18}$/.test(value)) throw new OrgHierarchyError("org-tenant-invalid");
  return value;
}

function require_safe_id(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256
    || value.trim() !== value || /[\u0000-]/u.test(value)) throw new OrgHierarchyError("org-id-invalid");
  return value;
}
