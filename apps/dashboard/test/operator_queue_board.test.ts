import { describe, expect, it } from "vitest";
import { parse_authenticated_principal } from "appointment-agent/dist/src/enterprise/authorization.js";
import {
  allowed_queue_actions,
  apply_queue_action,
  build_queue_rows,
  count_breached_items,
  escalation_slots_remaining,
  MAX_ESCALATION_LEVEL,
  queue_status_label,
  sla_state_label,
  sla_view,
  type QueueItem,
} from "../src/domain/operator_queue_board.js";
import { create_workspace_fixture, FIXTURE_TENANT_ID } from "../src/domain/fixtures.js";
import { build_fixture_claims } from "./support/fixture_principal.js";
import type { PrincipalClaims } from "../src/domain/principal_claims.js";

const NOW_MS = Date.parse("2026-03-02T09:00:00.000Z");
const NOW = new Date(NOW_MS);

function item(item_id: string): QueueItem {
  const found = create_workspace_fixture(NOW_MS).queue_items.find((candidate) => candidate.item_id === item_id);
  if (found === undefined) throw new Error(`fixture-missing-${item_id}`);
  return found;
}

function principal(role: "operator" | "analyst" | "owner" = "operator") {
  const claims: PrincipalClaims = build_fixture_claims(FIXTURE_TENANT_ID, role);
  return parse_authenticated_principal(claims);
}

describe("allowed_queue_actions", () => {
  it("offers the full workflow for an unassigned item", () => {
    expect(allowed_queue_actions(item("queue-fixture-unassigned"), principal(), FIXTURE_TENANT_ID))
      .toEqual(["assign", "escalate", "resolve"]);
  });

  it("withholds escalate once the escalation cap is reached", () => {
    expect(allowed_queue_actions(item("queue-fixture-capped"), principal(), FIXTURE_TENANT_ID))
      .toEqual(["assign", "resolve"]);
  });

  it("offers nothing for a resolved item", () => {
    expect(allowed_queue_actions(item("queue-fixture-resolved"), principal(), FIXTURE_TENANT_ID)).toEqual([]);
  });

  it("offers nothing when the role cannot read the handoff queue", () => {
    expect(allowed_queue_actions(item("queue-fixture-unassigned"), principal("analyst"), FIXTURE_TENANT_ID)).toEqual([]);
  });

  it("offers nothing for a queue item owned by another tenant", () => {
    expect(allowed_queue_actions(item("queue-fixture-unassigned"), principal(), "2002")).toEqual([]);
  });
});

describe("apply_queue_action", () => {
  it("assigns an item to the chosen operator subject", () => {
    const outcome = apply_queue_action(item("queue-fixture-unassigned"), "assign", principal(), FIXTURE_TENANT_ID, {
      assignee_subject: "local-supervisor",
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.item.status).toBe("assigned");
      expect(outcome.item.assignee_subject).toBe("local-supervisor");
    }
  });

  it("refuses to assign without a subject", () => {
    expect(apply_queue_action(item("queue-fixture-unassigned"), "assign", principal(), FIXTURE_TENANT_ID))
      .toEqual({ ok: false, code: "operator-queue-assignee-required" });
  });

  it("refuses to assign an already resolved item", () => {
    expect(apply_queue_action(item("queue-fixture-resolved"), "assign", principal(), FIXTURE_TENANT_ID, { assignee_subject: "local-operator" }))
      .toEqual({ ok: false, code: "operator-queue-assign-resolved" });
  });

  it("escalates one level with a bounded reason code", () => {
    const before = item("queue-fixture-escalated");
    const outcome = apply_queue_action(before, "escalate", principal(), FIXTURE_TENANT_ID, { reason_code: "sla_risk" });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.item.escalation_level).toBe(before.escalation_level + 1);
  });

  it("reports the domain code for an unbounded reason code", () => {
    expect(apply_queue_action(item("queue-fixture-escalated"), "escalate", principal(), FIXTURE_TENANT_ID, { reason_code: "Customer is angry" }))
      .toEqual({ ok: false, code: "operator-queue-reason-invalid" });
  });

  it("reports the domain code when escalation is already capped", () => {
    expect(apply_queue_action(item("queue-fixture-capped"), "escalate", principal(), FIXTURE_TENANT_ID, { reason_code: "sla_risk" }))
      .toEqual({ ok: false, code: "operator-queue-escalation-max" });
  });

  it("resolves an open item and reports a second resolve as already resolved", () => {
    const outcome = apply_queue_action(item("queue-fixture-unassigned"), "resolve", principal(), FIXTURE_TENANT_ID);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.item.status).toBe("resolved");
      expect(apply_queue_action(outcome.item, "resolve", principal(), FIXTURE_TENANT_ID))
        .toEqual({ ok: false, code: "operator-queue-already-resolved" });
    }
  });

  it("refuses a cross-tenant transition before reaching the domain", () => {
    expect(apply_queue_action(item("queue-fixture-unassigned"), "resolve", principal(), "2002"))
      .toEqual({ ok: false, code: "operator-queue-tenant-mismatch" });
  });

  it("never throws for a role without handoff rights", () => {
    expect(apply_queue_action(item("queue-fixture-unassigned"), "resolve", principal("analyst"), FIXTURE_TENANT_ID))
      .toEqual({ ok: false, code: "authorization-forbidden" });
  });
});

describe("escalation_slots_remaining", () => {
  it("reports the remaining levels against the domain cap", () => {
    expect(escalation_slots_remaining(item("queue-fixture-unassigned"))).toBe(MAX_ESCALATION_LEVEL);
    expect(escalation_slots_remaining(item("queue-fixture-capped"))).toBe(0);
  });

  it("never returns a negative count", () => {
    expect(escalation_slots_remaining({ ...item("queue-fixture-capped"), escalation_level: 5 })).toBe(0);
  });
});

describe("sla_view", () => {
  it("reports a breached deadline for an overdue item", () => {
    expect(sla_view(item("queue-fixture-breached"), NOW).state).toBe("breached");
  });

  it("reports due soon inside the warning window", () => {
    expect(sla_view(item("queue-fixture-escalated"), NOW).state).toBe("due_soon");
  });

  it("reports on track for a comfortable deadline", () => {
    expect(sla_view(item("queue-fixture-unassigned"), NOW).state).toBe("on_track");
  });

  it("reports met for a resolved item even when the deadline passed", () => {
    const view = sla_view(item("queue-fixture-resolved"), new Date(NOW_MS + 10_000_000));
    expect(view.state).toBe("met");
    expect(view.minutes_remaining).toBe(0);
  });

  it("computes whole minutes remaining", () => {
    expect(sla_view(item("queue-fixture-unassigned"), NOW).minutes_remaining).toBe(30);
  });
});

describe("build_queue_rows", () => {
  it("projects every item with its SLA state, actions, and remaining levels", () => {
    const rows = build_queue_rows(create_workspace_fixture(NOW_MS).queue_items, principal(), FIXTURE_TENANT_ID, NOW);
    expect(rows).toHaveLength(6);
    expect(rows.find((row) => row.item.item_id === "queue-fixture-breached")?.sla.state).toBe("breached");
    expect(rows.find((row) => row.item.item_id === "queue-fixture-capped")?.escalation_slots_remaining).toBe(0);
  });

  it("counts only open items as breached", () => {
    expect(count_breached_items(create_workspace_fixture(NOW_MS).queue_items, NOW)).toBe(1);
  });
});

describe("labels", () => {
  it("labels every queue status and SLA state", () => {
    expect(queue_status_label("escalated")).toBe("Escalated");
    expect(sla_state_label("due_soon")).toBe("Due soon");
  });
});