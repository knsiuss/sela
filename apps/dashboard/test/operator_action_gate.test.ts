/**
 * Classification coverage for the operator-action MFA gate.
 *
 * The gate is the reason a session's MFA evidence matters, and it used to be
 * decided twice: once by the enterprise contract, keyed on the *permission*, and
 * once by the caller, keyed on the *action name*. A newly added action mapping to
 * a gated permission would therefore have skipped `mfa_required` with no type
 * error and no failing test. These assertions are table-driven over the whole
 * audited action union precisely so that gap cannot reopen silently.
 */

import { describe, expect, it } from "vitest";
import { authorize, authorize_privileged, permission_requires_mfa } from "appointment-agent/dist/src/enterprise/authorization.js";
import type { EnterprisePermission } from "appointment-agent/dist/src/enterprise/authorization.js";
import { authorize_operator_action, type ActionAuthorization } from "../src/domain/action_receipt.js";
import { OPERATOR_ACTIONS } from "../src/domain/operator_action_gateway.js";
import { build_fixture_principal } from "./support/fixture_principal.js";

const TENANT_ID = "1001";

/**
 * The action-to-permission mapping this boundary applies, restated here on
 * purpose: a mapping change that is not mirrored in this table fails the
 * classification assertions below instead of passing unnoticed.
 */
const ACTION_PERMISSIONS: Record<string, EnterprisePermission> = {
  resolve_conflict: "appointments:reschedule",
  release_hold: "appointments:reschedule",
  reconcile_orphan: "appointments:reschedule",
  replay_outbound: "outbound:replay",
  export_audit: "audit:read",
};

/** Build a request for one action with a target and reason the contract accepts. */
function request_for(action: string): ActionAuthorization {
  return { tenant_id: TENANT_ID, action, target_id: "conflict-fixture-pending", reason: "operator_verified" };
}

/** Whether the enterprise contract demands MFA for one permission. */
function contract_requires_mfa(permission: EnterprisePermission): boolean {
  const unverified = build_fixture_principal(TENANT_ID, "owner", false);
  try {
    authorize_privileged(unverified, TENANT_ID, permission);
    return false;
  } catch (error) {
    expect(String((error as Error).message)).toContain("mfa-required");
    return true;
  }
}

describe("MFA-gate classification of every audited action", () => {
  it("covers the whole action union", () => {
    expect(Object.keys(ACTION_PERMISSIONS).sort()).toEqual([...OPERATOR_ACTIONS].sort());
  });

  it("routes each action through the same verdict as the authorization contract", () => {
    const unverified = build_fixture_principal(TENANT_ID, "owner", false);
    for (const action of OPERATOR_ACTIONS) {
      const permission = ACTION_PERMISSIONS[action];
      expect(permission, `no test mapping for ${action}`).toBeDefined();
      // The boundary must refuse exactly when the contract would demand MFA,
      // and must not refuse a gated action it decided was ungated.
      expect(permission_requires_mfa(permission)).toBe(contract_requires_mfa(permission));
      expect(authorize_operator_action(unverified, request_for(action)))
        .toBe(contract_requires_mfa(permission) ? "mfa_required" : null);
    }
  });

  it("authorizes every non-privileged action without a second factor", () => {
    const unverified = build_fixture_principal(TENANT_ID, "owner", false);
    const ungated = OPERATOR_ACTIONS.filter((action) => !permission_requires_mfa(ACTION_PERMISSIONS[action] as EnterprisePermission));
    expect(ungated).toContain("export_audit");
    for (const action of ungated) {
      expect(() => authorize(unverified, TENANT_ID, ACTION_PERMISSIONS[action] as EnterprisePermission)).not.toThrow();
    }
  });

  it("authorizes every gated action once the second factor is verified", () => {
    const verified = build_fixture_principal(TENANT_ID, "owner", true);
    const gated = OPERATOR_ACTIONS.filter((action) => permission_requires_mfa(ACTION_PERMISSIONS[action] as EnterprisePermission));
    expect(gated).toEqual(["replay_outbound"]);
    for (const action of gated) {
      expect(authorize_operator_action(verified, request_for(action))).toBeNull();
    }
  });

  it("still refuses a gated action for a role without the permission", () => {
    const operator = build_fixture_principal(TENANT_ID, "operator", true);
    // An operator holds no replay permission, so this is a denial on role rather
    // than on MFA; the classification above must not turn that into a pass.
    expect(authorize_operator_action(operator, request_for("replay_outbound"))).toBe("forbidden");
  });
});
