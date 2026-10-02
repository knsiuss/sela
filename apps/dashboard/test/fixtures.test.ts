import { describe, expect, it } from "vitest";
import {
  create_workspace_fixture,
  FIXTURE_TENANT_ID,
  FOREIGN_FIXTURE_TENANT_ID,
} from "../src/domain/fixtures.js";
import {
  expire_conflict,
  open_conflict,
  type ConflictStatus,
} from "appointment-agent/dist/src/enterprise/conflict_resolution.js";
import {
  enqueue_item,
  MAX_ESCALATION_LEVEL,
  type QueueItemStatus,
} from "appointment-agent/dist/src/enterprise/operator_queue.js";

const NOW_MS = Date.parse("2026-03-02T09:00:00.000Z");

/** Long digit runs are how phone numbers and confirmation codes leak. */
const LONG_DIGIT_RUN = /\d{4,}/;

describe("create_workspace_fixture", () => {
  it("covers every conflict lifecycle status", () => {
    const statuses = new Set(create_workspace_fixture(NOW_MS).conflicts.map((record) => record.status));
    const expected: ConflictStatus[] = ["pending", "proposed", "accepted", "rejected", "expired"];
    expect([...statuses].sort()).toEqual([...expected].sort());
  });

  it("covers every queue lifecycle status", () => {
    const statuses = new Set(create_workspace_fixture(NOW_MS).queue_items.map((item) => item.status));
    const expected: QueueItemStatus[] = ["unassigned", "assigned", "escalated", "resolved"];
    expect([...statuses].sort()).toEqual([...expected].sort());
  });

  it("includes an item that already reached the escalation cap", () => {
    const capped = create_workspace_fixture(NOW_MS).queue_items
      .filter((item) => item.escalation_level === MAX_ESCALATION_LEVEL);
    expect(capped).toHaveLength(1);
  });

  it("includes breached, due-soon, and on-track SLA deadlines", () => {
    const offsets = open_offsets_minutes(create_workspace_fixture(NOW_MS).queue_items);
    expect(offsets.some((minutes) => minutes < 0)).toBe(true);
    expect(offsets.some((minutes) => minutes >= 0 && minutes <= 15)).toBe(true);
    expect(offsets.some((minutes) => minutes > 15)).toBe(true);
  });

  it("keeps every conflict and queue item inside the local tenant", () => {
    const fixture = create_workspace_fixture(NOW_MS);
    expect([...fixture.conflicts, ...fixture.queue_items].every((row) => row.tenant_id === FIXTURE_TENANT_ID)).toBe(true);
  });

  it("includes foreign-tenant appointments only on the other tenant", () => {
    const fixture = create_workspace_fixture(NOW_MS);
    expect(fixture.foreign_appointments).toHaveLength(2);
    expect(fixture.foreign_appointments.every((row) => row.tenant_id === FOREIGN_FIXTURE_TENANT_ID)).toBe(true);
  });

  it("produces fixture records the real domain constructors also accept", () => {
    const fixture = create_workspace_fixture(NOW_MS);
    for (const record of fixture.conflicts) {
      expect(() => open_conflict({
        conflict_id: record.conflict_id, tenant_id: record.tenant_id, appointment_id: record.appointment_id,
        generation: record.generation, clock: () => new Date(NOW_MS),
      })).not.toThrow();
      expect(() => expire_conflict(record, new Date(NOW_MS - 1))).not.toThrow();
    }
    for (const item of fixture.queue_items) {
      expect(() => enqueue_item({
        item_id: item.item_id, tenant_id: item.tenant_id, sla_minutes: 30, clock: () => new Date(NOW_MS),
      })).not.toThrow();
    }
  });

  it("never embeds a long digit run outside the fields the domain makes numeric", () => {
    const fixture = create_workspace_fixture(NOW_MS);
    const numeric_by_contract = new Set([
      "tenant_id", "resource_id", "starts_at_iso", "ends_at_iso", "sla_due_at_iso",
      "expires_at_iso", "created_at_iso", "updated_at_iso", "decided_at_iso", "proposed_slot_iso",
    ]);
    const offenders = collect_digit_runs(fixture, numeric_by_contract);
    expect(offenders).toEqual([]);
  });

  it("is deterministic for a fixed reference time", () => {
    expect(JSON.stringify(create_workspace_fixture(NOW_MS))).toBe(JSON.stringify(create_workspace_fixture(NOW_MS)));
  });
});

/** Minutes from the reference time to each open item's deadline. */
function open_offsets_minutes(items: readonly { status: string; sla_due_at_iso: string }[]): number[] {
  return items
    .filter((item) => item.status !== "resolved")
    .map((item) => (Date.parse(item.sla_due_at_iso) - NOW_MS) / 60_000);
}

/** Report `field: value` pairs whose value looks like a phone number. */
function collect_digit_runs(value: unknown, skip_keys: ReadonlySet<string>, path = ""): string[] {
  if (typeof value === "string") return LONG_DIGIT_RUN.test(value) ? [`${path}=${value}`] : [];
  if (Array.isArray(value)) return value.flatMap((entry, index) => collect_digit_runs(entry, skip_keys, `${path}[${index}]`));
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, entry]) =>
    skip_keys.has(key) ? [] : collect_digit_runs(entry, skip_keys, path === "" ? key : `${path}.${key}`));
}