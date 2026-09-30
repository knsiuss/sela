import { describe, expect, it } from "vitest";
import { parse_authenticated_principal } from "../src/enterprise/authorization.js";
import {
  assign_item,
  enqueue_item,
  escalate_item,
  is_sla_breached,
  resolve_item,
  InMemoryOperatorQueue,
  OperatorQueueError,
} from "../src/enterprise/operator_queue.js";

const CLOCK = () => new Date("2026-09-30T00:00:00.000Z");
function principal() {
  return parse_authenticated_principal({
    subject_id: "op-1", session_id: "s-1", has_mfa: true,
    issued_at_iso: "2026-09-30T00:00:00.000Z", tenant_roles: { "42": ["operator"] },
  });
}

describe("operator queue assignment and escalation", () => {
  it("enqueues with an sla deadline then assigns", () => {
    const item = enqueue_item({ item_id: "item-1", tenant_id: "42", sla_minutes: 60, clock: CLOCK });
    expect(item.status).toBe("unassigned");
    expect(item.sla_due_at_iso).toBe("2026-09-30T01:00:00.000Z");
    const assigned = assign_item(item, "op-1", principal(), "42");
    expect(assigned).toMatchObject({ status: "assigned", assignee_subject: "op-1" });
  });

  it("escalates up to the max level with bounded reasons", () => {
    let item = assign_item(
      enqueue_item({ item_id: "item-1", tenant_id: "42", sla_minutes: 60, clock: CLOCK }), "op-1", principal(), "42",
    );
    item = escalate_item(item, principal(), "42", "needs_lead");
    expect(item.escalation_level).toBe(1);
    expect(() => escalate_item(item, principal(), "42", "Bad Reason!")).toThrow("operator-queue-reason-invalid");
  });

  it("resolves terminally and detects sla breach", () => {
    const item = enqueue_item({ item_id: "item-1", tenant_id: "42", sla_minutes: 1, clock: CLOCK });
    expect(is_sla_breached(item, new Date("2026-09-30T02:00:00.000Z"))).toBe(true);
    const resolved = resolve_item(item, principal(), "42");
    expect(resolved.status).toBe("resolved");
    expect(is_sla_breached(resolved, new Date("2026-09-30T05:00:00.000Z"))).toBe(false);
    expect(() => resolve_item(resolved, principal(), "42")).toThrow("operator-queue-already-resolved");
  });

  it("rejects cross-tenant and unauthorized actions", () => {
    const item = enqueue_item({ item_id: "item-1", tenant_id: "42", sla_minutes: 60, clock: CLOCK });
    expect(() => assign_item(item, "op-1", principal(), "43")).toThrow();
    const outsider = parse_authenticated_principal({
      subject_id: "x", session_id: "s", has_mfa: true,
      issued_at_iso: "2026-09-30T00:00:00.000Z", tenant_roles: { "99": ["operator"] },
    });
    expect(() => assign_item(item, "op-1", outsider, "42")).toThrow();
  });

  it("persists through the in-memory queue", async () => {
    const queue = new InMemoryOperatorQueue();
    const item = enqueue_item({ item_id: "q-1", tenant_id: "42", sla_minutes: 60, clock: CLOCK });
    await queue.save(item);
    expect((await queue.get("q-1"))?.item_id).toBe("q-1");
    expect(await queue.get("missing")).toBeNull();
    expect(() => enqueue_item({ item_id: "q-2", tenant_id: "42", sla_minutes: 0, clock: CLOCK }))
      .toThrow(OperatorQueueError);
  });
});
