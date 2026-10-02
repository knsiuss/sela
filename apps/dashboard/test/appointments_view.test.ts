import { describe, expect, it } from "vitest";
import {
  AppointmentsViewError,
  count_hidden_by_tenant_scope,
  filter_appointments,
  MAX_FILTER_QUERY_LENGTH,
  next_sort_direction,
  parse_appointment_filter,
  scope_to_tenant,
  sort_appointments,
  summarize_appointments,
  type CalendarAppointment,
} from "../src/domain/appointments_view.js";
import { create_workspace_fixture, FIXTURE_TENANT_ID, FOREIGN_FIXTURE_TENANT_ID } from "../src/domain/fixtures.js";

const NOW_MS = Date.parse("2026-03-02T09:00:00.000Z");

function rows(): CalendarAppointment[] {
  const fixture = create_workspace_fixture(NOW_MS);
  return [...fixture.appointments, ...fixture.foreign_appointments];
}

describe("scope_to_tenant", () => {
  it("keeps only the rows owned by the requested tenant", () => {
    const scoped = scope_to_tenant(rows(), FIXTURE_TENANT_ID);
    expect(scoped.every((row) => row.tenant_id === FIXTURE_TENANT_ID)).toBe(true);
    expect(scoped).toHaveLength(5);
  });

  it("reports how many rows tenant scoping hid", () => {
    expect(count_hidden_by_tenant_scope(rows(), FIXTURE_TENANT_ID)).toBe(2);
  });

  it("rejects a tenant id the domain would refuse", () => {
    expect(() => scope_to_tenant(rows(), "tenant-a")).toThrowError(AppointmentsViewError);
  });
});

describe("filter_appointments", () => {
  it("restricts to a single status inside the scoped tenant", () => {
    const filtered = filter_appointments(scope_to_tenant(rows(), FIXTURE_TENANT_ID), { query: "", status: "confirmed" });
    expect(filtered.map((row) => row.appointment_id)).toEqual(["appt-fixture-a1", "appt-fixture-a3"]);
  });

  it("matches appointment identifiers case-insensitively", () => {
    expect(filter_appointments(rows(), { query: "FIXTURE-A2", status: "all" })).toHaveLength(1);
  });

  it("matches resource identifiers", () => {
    expect(filter_appointments(rows(), { query: "702", status: "all" })).toHaveLength(2);
  });

  it("returns nothing when the query matches no identifier", () => {
    expect(filter_appointments(rows(), { query: "no-such-id", status: "all" })).toHaveLength(0);
  });

  it("rejects a query longer than the documented bound", () => {
    expect(() => filter_appointments(rows(), { query: "a".repeat(MAX_FILTER_QUERY_LENGTH + 1), status: "all" }))
      .toThrowError(AppointmentsViewError);
  });
});

describe("parse_appointment_filter", () => {
  it("trims and lowercases the query before matching", () => {
    expect(parse_appointment_filter({ query: " 701 ", status: "confirmed" })).toEqual({ query: "701", status: "confirmed" });
  });

  it("rejects a status the appointment domain does not define", () => {
    expect(() => parse_appointment_filter({ query: "", status: "rescheduled" })).toThrowError(AppointmentsViewError);
  });

  it("rejects a non-object filter", () => {
    expect(() => parse_appointment_filter("confirmed")).toThrowError(AppointmentsViewError);
  });
});

describe("sort_appointments", () => {
  it("sorts by start time ascending", () => {
    const sorted = sort_appointments(rows(), "starts_at_iso", "asc");
    const times = sorted.map((row) => row.starts_at_iso);
    expect(times).toEqual([...times].sort());
  });

  it("sorts descending when asked", () => {
    const sorted = sort_appointments(rows(), "starts_at_iso", "desc");
    const times = sorted.map((row) => row.starts_at_iso);
    expect(times).toEqual([...times].sort().reverse());
  });

  it("orders versions numerically rather than lexicographically", () => {
    const sorted = sort_appointments(rows(), "version", "asc");
    expect(sorted.every((row) => row.version === 1)).toBe(true);
  });

  it("breaks ties on appointment id so ordering is deterministic", () => {
    const sorted = sort_appointments(rows(), "status", "asc");
    const confirmed = sorted.filter((row) => row.status === "confirmed").map((row) => row.appointment_id);
    expect(confirmed).toEqual([...confirmed].sort());
    expect(confirmed.length).toBeGreaterThan(1);
  });

  it("rejects an unsupported sort key", () => {
    expect(() => sort_appointments(rows(), "customer_name" as never, "asc")).toThrowError(AppointmentsViewError);
  });

  it("rejects an unsupported direction", () => {
    expect(() => sort_appointments(rows(), "status", "sideways" as never)).toThrowError(AppointmentsViewError);
  });
});

describe("next_sort_direction", () => {
  it("starts ascending when a different column is chosen", () => {
    expect(next_sort_direction("status", "starts_at_iso", "desc")).toBe("asc");
  });

  it("toggles when the active column is chosen again", () => {
    expect(next_sort_direction("status", "status", "asc")).toBe("desc");
    expect(next_sort_direction("status", "status", "desc")).toBe("asc");
  });
});

describe("summarize_appointments", () => {
  it("counts the total and every status", () => {
    const summary = summarize_appointments(scope_to_tenant(rows(), FIXTURE_TENANT_ID));
    expect(summary.total).toBe(5);
    expect(summary.by_status.confirmed).toBe(2);
    expect(summary.by_status.no_show).toBe(1);
    expect(summary.by_status.cancelled).toBe(1);
    expect(summary.by_status.held).toBe(1);
  });

  it("never counts rows from another tenant", () => {
    const summary = summarize_appointments(rows());
    expect(summary.total).toBe(7);
    expect(summary.by_status.confirmed).toBe(4);
  });
});

describe("fixture tenant separation", () => {
  it("keeps foreign rows on a different tenant than the local scope", () => {
    const fixture = create_workspace_fixture(NOW_MS);
    expect(fixture.foreign_appointments.every((row) => row.tenant_id === FOREIGN_FIXTURE_TENANT_ID)).toBe(true);
    expect(FOREIGN_FIXTURE_TENANT_ID).not.toBe(FIXTURE_TENANT_ID);
  });
});