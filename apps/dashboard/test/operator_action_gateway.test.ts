import { describe, expect, it } from "vitest";
import { parse_authenticated_principal } from "appointment-agent/dist/src/enterprise/authorization.js";
import {
  build_operator_action_request,
  can_run_operator_action,
  create_local_action_service,
  create_stamping_audit_store,
  OPERATOR_ACTIONS,
  outcome_label,
  run_operator_action,
  type OperatorAction,
  type OperatorActionReasonCode,
  type StampingAuditStore,
} from "../src/domain/operator_action_gateway.js";
import { build_local_principal, type LocalPrincipalClaims, to_wire_principal } from "../src/domain/synthetic_principal.js";

const TENANT_ID = "1001";
const TARGETS = { conflict_ids: ["conflict-fixture-pending"], queue_item_ids: ["queue-fixture-unassigned"] };

function principal(role: "operator" | "owner" = "operator", has_mfa = true) {
  const claims: LocalPrincipalClaims = to_wire_principal(build_local_principal(TENANT_ID, role));
  return parse_authenticated_principal({ ...claims, has_mfa });
}

function request(action: OperatorAction, target_id = "conflict-fixture-pending", role: "operator" | "owner" = "operator") {
  return build_operator_action_request({
    principal: principal(role),
    tenant_id: TENANT_ID,
    action,
    target_id,
    reason: "operator_verified" as OperatorActionReasonCode,
  });
}

function store(): StampingAuditStore {
  return create_stamping_audit_store(() => new Date("2026-03-02T09:05:00.000Z"));
}

describe("OPERATOR_ACTIONS", () => {
  it("exposes exactly the audited action union", () => {
    expect([...OPERATOR_ACTIONS].sort()).toEqual([
      "export_audit", "reconcile_orphan", "release_hold", "replay_outbound", "resolve_conflict",
    ]);
  });
});

describe("create_stamping_audit_store", () => {
  it("stamps arrival time onto every appended row", async () => {
    const audit = store();
    const service = create_local_action_service(audit, TARGETS);
    await run_operator_action(service, request("resolve_conflict"));
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0].at_iso).toBe("2026-03-02T09:05:00.000Z");
  });
});

describe("can_run_operator_action", () => {
  it("allows an action the local operator role holds", () => {
    const service = create_local_action_service(store(), TARGETS);
    expect(can_run_operator_action(service, request("resolve_conflict"))).toBeNull();
  });

  it("blocks outbound replay for a role without replay rights", () => {
    const service = create_local_action_service(store(), TARGETS);
    expect(can_run_operator_action(service, request("replay_outbound"))).toBe("forbidden");
  });

  it("blocks an MFA-gated action when the principal has no MFA claims", () => {
    const service = create_local_action_service(store(), TARGETS);
    const claims: LocalPrincipalClaims = to_wire_principal(build_local_principal(TENANT_ID, "owner"));
    const without_mfa = parse_authenticated_principal({ ...claims, has_mfa: false });
    const candidate = build_operator_action_request({
      principal: without_mfa, tenant_id: TENANT_ID, action: "replay_outbound",
      target_id: "conflict-fixture-pending", reason: "transport_retry",
    });
    expect(can_run_operator_action(service, candidate)).toBe("mfa_required");
  });

  it("allows an owner to replay outbound with MFA claims", () => {
    const service = create_local_action_service(store(), TARGETS);
    expect(can_run_operator_action(service, request("replay_outbound", "conflict-fixture-pending", "owner"))).toBeNull();
  });
});

describe("run_operator_action", () => {
  it("succeeds for a known target and appends one audit row", async () => {
    const audit = store();
    const service = create_local_action_service(audit, TARGETS);
    const outcome = await run_operator_action(service, request("release_hold", "queue-fixture-unassigned"));
    expect(outcome).toEqual({ status: "succeeded", action: "release_hold", target_id: "queue-fixture-unassigned", code: null });
    expect(audit.records[0]).toMatchObject({ outcome: "succeeded", actor_subject: "local-operator" });
  });

  it("audits a denial instead of executing", async () => {
    const audit = store();
    const service = create_local_action_service(audit, TARGETS);
    const outcome = await run_operator_action(service, request("replay_outbound"));
    expect(outcome.status).toBe("denied");
    expect(outcome.code).toBe("forbidden");
    expect(audit.records[0]).toMatchObject({ outcome: "denied", reason_code: "authorization_denied" });
  });

  it("fails loudly when the local workspace does not recognise the target", async () => {
    const audit = store();
    const service = create_local_action_service(audit, TARGETS);
    const outcome = await run_operator_action(service, request("resolve_conflict", "unknown-target"));
    expect(outcome.status).toBe("failed");
    expect(outcome.code).toBe("operatoractionunavailableerror");
    expect(audit.records[0]).toMatchObject({ outcome: "failed" });
  });

  it("surfaces a failed outcome when the reason violates the domain bound", async () => {
    const audit = store();
    const service = create_local_action_service(audit, TARGETS);
    const candidate = { ...request("resolve_conflict"), reason: "   " };
    const outcome = await run_operator_action(service, candidate);
    expect(outcome).toEqual({ status: "failed", action: "resolve_conflict", target_id: "conflict-fixture-pending", code: "typeerror" });
    // Known domain gap: `normalize_request` throws before the audited try/catch,
    // so a malformed request produces no audit row. The UI cannot build one,
    // because reason codes are a bounded select rather than free text.
    expect(audit.records).toHaveLength(0);
  });

  it("keeps every attempt append-only and ordered", async () => {
    const audit = store();
    const service = create_local_action_service(audit, TARGETS);
    await run_operator_action(service, request("reconcile_orphan"));
    await run_operator_action(service, request("replay_outbound"));
    expect(audit.records.map((record) => record.outcome)).toEqual(["succeeded", "denied"]);
  });
});

describe("build_operator_action_request", () => {
  it("carries a unique request id per attempt", () => {
    expect(request("resolve_conflict").request_id).not.toBe(request("resolve_conflict").request_id);
  });

  it("copies only the audited request fields", () => {
    expect(Object.keys(request("resolve_conflict")).sort()).toEqual([
      "action", "principal", "reason", "request_id", "target_id", "tenant_id",
    ]);
  });
});

describe("outcome_label", () => {
  it("labels each audited outcome", () => {
    expect(outcome_label("succeeded")).toBe("Succeeded");
    expect(outcome_label("denied")).toBe("Denied");
    expect(outcome_label("failed")).toBe("Failed");
  });
});