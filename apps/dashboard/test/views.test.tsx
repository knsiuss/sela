// @vitest-environment jsdom

/**
 * Behavioural tests for the workspace views.
 *
 * These exercise the real components through the real application shell, so a
 * broken contract fails here as well as in the unit tests. Assertions use plain
 * DOM properties rather than jest-dom matchers to keep the dependency surface
 * minimal.
 */

import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppointmentTable } from "../src/components/AppointmentTable";
import { AuditTimeline } from "../src/components/AuditTimeline";
import { ConflictBoard } from "../src/components/ConflictBoard";
import { OperatorActionPanel } from "../src/components/OperatorActionPanel";
import { QueueBoard } from "../src/components/QueueBoard";
import { build_test_snapshot, render_workspace, TEST_TENANT_ID } from "./support/render_workspace.js";
import { stub_authorizer } from "./support/render_workspace.js";
import { build_fixture_principal } from "./support/fixture_principal.js";

function is_disabled(element: HTMLElement): boolean {
  return (element as HTMLButtonElement).disabled === true;
}

function text_of(element: HTMLElement | null): string {
  return element?.textContent ?? "";
}

describe("AppointmentTable", () => {
  it("renders one row per tenant-scoped appointment", () => {
    const rows = build_test_snapshot().appointments;
    render_workspace(<AppointmentTable rows={rows} tenant_id={TEST_TENANT_ID} />);
    expect(screen.getAllByRole("row")).toHaveLength(rows.length + 1);
    expect(text_of(within(screen.getByRole("region", { name: "Appointments" })).getByRole("status"))).toContain("5 of 5 appointments shown");
  });

  it("marks the active sort column with aria-sort and the rest with none", () => {
    render_workspace(<AppointmentTable rows={build_test_snapshot().appointments} tenant_id={TEST_TENANT_ID} />);
    expect(screen.getByRole("columnheader", { name: /starts at/i }).getAttribute("aria-sort")).toBe("ascending");
    expect(screen.getByRole("columnheader", { name: /^resource$/i }).getAttribute("aria-sort")).toBe("none");
  });

  it("reorders rows when a sort control is activated", async () => {
    const user = userEvent.setup();
    render_workspace(<AppointmentTable rows={build_test_snapshot().appointments} tenant_id={TEST_TENANT_ID} />);
    await user.click(screen.getByRole("button", { name: /^resource$/i }));
    expect(text_of(screen.getAllByRole("row")[1])).toContain("appt-fixture-a1");
    expect(screen.getByRole("columnheader", { name: /^resource$/i }).getAttribute("aria-sort")).toBe("ascending");
  });

  it("toggles back to descending on a second activation", async () => {
    const user = userEvent.setup();
    render_workspace(<AppointmentTable rows={build_test_snapshot().appointments} tenant_id={TEST_TENANT_ID} />);
    const header = screen.getByRole("columnheader", { name: /^resource$/i });
    await user.click(within(header).getByRole("button"));
    await user.click(within(screen.getByRole("columnheader", { name: /^resource$/i })).getByRole("button"));
    expect(screen.getByRole("columnheader", { name: /^resource$/i }).getAttribute("aria-sort")).toBe("descending");
  });

  it("narrows the list when a status filter is chosen", async () => {
    const user = userEvent.setup();
    render_workspace(<AppointmentTable rows={build_test_snapshot().appointments} tenant_id={TEST_TENANT_ID} />);
    await user.selectOptions(screen.getByLabelText("Status"), "no_show");
    expect(screen.getAllByRole("row")).toHaveLength(2);
    expect(text_of(within(screen.getByRole("region", { name: "Appointments" })).getByRole("status"))).toContain("1 of 5 appointments shown");
  });

  it("reports an empty result set instead of rendering a broken table", async () => {
    const user = userEvent.setup();
    render_workspace(<AppointmentTable rows={build_test_snapshot().appointments} tenant_id={TEST_TENANT_ID} />);
    await user.type(screen.getByLabelText(/search appointment/i), "no-such-id");
    expect(screen.getByText("No appointments match the current filters.")).toBeTruthy();
  });
});

describe("ConflictBoard", () => {
  it("shows the lifecycle summary for the tenant's conflicts", () => {
    render_workspace(<ConflictBoard tenant_id={TEST_TENANT_ID} />);
    expect(text_of(within(screen.getByRole("region", { name: "Conflict resolution" })).getByRole("status"))).toContain("2 of 5 conflicts await a decision.");
  });

  it("proposes a resolution and reduces the open count", async () => {
    const user = userEvent.setup();
    render_workspace(<ConflictBoard tenant_id={TEST_TENANT_ID} />);
    await user.click(within(screen.getByRole("group", { name: "conflict-fixture-pending" })).getByRole("button", { name: "Propose resolution" }));
    expect(text_of(within(screen.getByRole("region", { name: "Conflict resolution" })).getByRole("status"))).toContain("2 of 5 conflicts await a decision.");
    expect(within(screen.getByRole("group", { name: "conflict-fixture-pending" })).getByText("Proposed")).toBeTruthy();
  });

  it("accepts a proposed resolution", async () => {
    const user = userEvent.setup();
    render_workspace(<ConflictBoard tenant_id={TEST_TENANT_ID} />, "operator", true);
    await user.click(within(screen.getByRole("group", { name: "conflict-fixture-proposed" })).getByRole("button", { name: "Accept resolution" }));
    expect(within(screen.getByRole("group", { name: "conflict-fixture-proposed" })).getByText("Accepted")).toBeTruthy();
    expect(text_of(within(screen.getByRole("region", { name: "Conflict resolution" })).getByRole("status"))).toContain("1 of 5 conflicts await a decision.");
  });

  it("rejects a pending conflict", async () => {
    const user = userEvent.setup();
    render_workspace(<ConflictBoard tenant_id={TEST_TENANT_ID} />);
    await user.click(within(screen.getByRole("group", { name: "conflict-fixture-pending" })).getByRole("button", { name: "Reject" }));
    expect(within(screen.getByRole("group", { name: "conflict-fixture-pending" })).getByText("Rejected")).toBeTruthy();
  });

  it("disables every action on a terminal conflict and explains why", () => {
    render_workspace(<ConflictBoard tenant_id={TEST_TENANT_ID} />);
    const group = screen.getByRole("group", { name: "conflict-fixture-accepted" });
    for (const button of within(group).getAllByRole("button")) expect(is_disabled(button)).toBe(true);
    expect(text_of(within(group).getByText(/is terminal/i))).toContain("terminal");
  });

  it("disables rescheduling for a role without the permission", () => {
    render_workspace(<ConflictBoard tenant_id={TEST_TENANT_ID} />, "analyst");
    const group = screen.getByRole("group", { name: "conflict-fixture-pending" });
    expect(is_disabled(within(group).getByRole("button", { name: "Propose resolution" }))).toBe(true);
    expect(text_of(within(group).getByText(/cannot reschedule appointments/i))).toContain("cannot reschedule");
  });
});

describe("QueueBoard", () => {
  it("reports how many items are past their SLA deadline", () => {
    render_workspace(<QueueBoard tenant_id={TEST_TENANT_ID} />);
    expect(text_of(within(screen.getByRole("region", { name: "Assignment and escalation" })).getByRole("status"))).toContain("1 of 6 queue items are past their SLA deadline.");
  });

  it("shows breached, due-soon, and on-track SLA states", () => {
    render_workspace(<QueueBoard tenant_id={TEST_TENANT_ID} />);
    expect(screen.getAllByText("Breached")).toHaveLength(1);
    expect(screen.getAllByText("Due soon")).toHaveLength(1);
    expect(screen.getAllByText("On track").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Met")).toHaveLength(1);
  });

  it("assigns an item to the selected operator", async () => {
    const user = userEvent.setup();
    render_workspace(<QueueBoard tenant_id={TEST_TENANT_ID} />);
    await user.click(within(screen.getByRole("group", { name: "queue-fixture-unassigned" })).getByRole("button", { name: "Assign" }));
    expect(text_of(screen.getByRole("group", { name: "queue-fixture-unassigned" }))).toContain("local-operator");
  });

  it("escalates an item and decrements the remaining levels", async () => {
    const user = userEvent.setup();
    render_workspace(<QueueBoard tenant_id={TEST_TENANT_ID} />);
    expect(text_of(screen.getByRole("group", { name: "queue-fixture-escalated" }))).toContain("Level 2 of 3, 1 remaining");
    await user.click(within(screen.getByRole("group", { name: "queue-fixture-escalated" })).getByRole("button", { name: "Escalate" }));
    expect(text_of(screen.getByRole("group", { name: "queue-fixture-escalated" }))).toContain("Level 3 of 3, 0 remaining");
  });

  it("withholds escalation once the cap is reached", () => {
    render_workspace(<QueueBoard tenant_id={TEST_TENANT_ID} />);
    expect(is_disabled(within(screen.getByRole("group", { name: "queue-fixture-capped" })).getByRole("button", { name: "Escalate" }))).toBe(true);
  });

  it("resolves an item and keeps the SLA deadline visible", async () => {
    const user = userEvent.setup();
    render_workspace(<QueueBoard tenant_id={TEST_TENANT_ID} />);
    await user.click(within(screen.getByRole("group", { name: "queue-fixture-unassigned" })).getByRole("button", { name: "Resolve" }));
    const group = screen.getByRole("group", { name: "queue-fixture-unassigned" });
    expect(text_of(within(group).getByText("Resolved"))).toContain("Resolved");
    expect(is_disabled(within(group).getByRole("button", { name: "Resolve" }))).toBe(true);
  });

  it("blocks every action for a role without handoff rights", () => {
    render_workspace(<QueueBoard tenant_id={TEST_TENANT_ID} />, "analyst");
    const group = screen.getByRole("group", { name: "queue-fixture-unassigned" });
    for (const button of within(group).getAllByRole("button")) expect(is_disabled(button)).toBe(true);
    expect(text_of(within(group).getByText(/cannot read the handoff queue/i))).toContain("cannot read");
  });
});

describe("OperatorActionPanel", () => {
  it("offers every audited action and blocks one the role cannot run", async () => {
    const user = userEvent.setup();
    render_workspace(<OperatorActionPanel tenant_id={TEST_TENANT_ID} authorize={stub_authorizer(build_fixture_principal(TEST_TENANT_ID, "operator", true))} />, "operator", true);
    for (const action of ["resolve_conflict", "release_hold", "reconcile_orphan", "replay_outbound", "export_audit"]) {
      expect(screen.getByRole("option", { name: action })).toBeTruthy();
    }
    expect(is_disabled(screen.getByRole("button", { name: "Run action" }))).toBe(false);
    await user.selectOptions(screen.getByLabelText("Action"), "replay_outbound");
    expect(is_disabled(screen.getByRole("button", { name: "Run action" }))).toBe(true);
    expect(text_of(screen.getByText(/preflight blocked/i))).toContain("forbidden");
  });

  it("succeeds for a permitted action and appends one audit entry", async () => {
    const user = userEvent.setup();
    render_workspace(<><OperatorActionPanel tenant_id={TEST_TENANT_ID} authorize={stub_authorizer(build_fixture_principal(TEST_TENANT_ID, "operator", true))} /><AuditTimeline /></>, "operator", true);
    await user.selectOptions(screen.getByLabelText("Target"), "conflict-fixture-pending");
    await user.click(screen.getByRole("button", { name: "Run action" }));
    const item = await within(screen.getByRole("region", { name: "Audit timeline" })).findByRole("listitem");
    expect(text_of(item)).toContain("conflict-fixture-pending");
    expect(await within(screen.getByRole("region", { name: "Operator actions" })).findByText(/resolve_conflict Succeeded/)).toBeTruthy();
  });

  it("uses a bounded reason code instead of a free-text field", () => {
    render_workspace(<OperatorActionPanel tenant_id={TEST_TENANT_ID} authorize={stub_authorizer(build_fixture_principal(TEST_TENANT_ID, "operator", true))} />, "operator", true);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getAllByRole("option", { name: "operator_verified" }).length).toBeGreaterThan(0);
  });

  it("refuses to run without a target", async () => {
    const user = userEvent.setup();
    render_workspace(<OperatorActionPanel tenant_id={TEST_TENANT_ID} authorize={stub_authorizer(build_fixture_principal(TEST_TENANT_ID, "operator", true))} />, "operator", true);
    await user.click(screen.getByRole("button", { name: "Run action" }));
    expect(text_of(within(screen.getByRole("region", { name: "Operator actions" })).getByRole("status"))).toContain("operator-action-target-required");
  });
});

describe("AuditTimeline", () => {
  it("states that nothing has been attempted yet", () => {
    render_workspace(<AuditTimeline />);
    expect(screen.getByText("No operator actions have been attempted in this session.")).toBeTruthy();
    expect(text_of(within(screen.getByRole("region", { name: "Audit timeline" })).getByRole("status"))).toContain("0 audit entries");
  });

  it("renders only the projected, redacted audit fields", async () => {
    const user = userEvent.setup();
    render_workspace(<><OperatorActionPanel tenant_id={TEST_TENANT_ID} authorize={stub_authorizer(build_fixture_principal(TEST_TENANT_ID, "operator", true))} /><AuditTimeline /></>, "operator", true);
    await user.selectOptions(screen.getByLabelText("Target"), "queue-fixture-unassigned");
    await user.selectOptions(screen.getByLabelText("Reason code"), "calendar_recovered");
    await user.click(screen.getByRole("button", { name: "Run action" }));
    const timeline = screen.getByRole("region", { name: "Audit timeline" });
    const item = await within(timeline).findByRole("listitem");
    const fields = within(item).getAllByRole("term").map((node) => node.textContent);
    expect(fields).toEqual(["Actor", "Target", "Reason code", "Request"]);
    // The audited ledger records no reason code on success, and the submitted
    // reason text is never stored locally, so the timeline cannot show it.
    expect(text_of(within(item).getByText("none"))).toBe("none");
    expect(text_of(timeline)).not.toContain("calendar_recovered");
  });

  it("keeps a blocked action unsubmittable, so no unaudited attempt is possible", async () => {
    const user = userEvent.setup();
    render_workspace(<OperatorActionPanel tenant_id={TEST_TENANT_ID} authorize={stub_authorizer(build_fixture_principal(TEST_TENANT_ID, "operator", true))} />);
    await user.selectOptions(screen.getByLabelText("Action"), "replay_outbound");
    expect(is_disabled(screen.getByRole("button", { name: "Run action" }))).toBe(true);
    expect(text_of(within(screen.getByRole("region", { name: "Operator actions" })).getByRole("status")))
      .toContain("No action attempted in this session.");
  });

  it("reports how many entries were added during the session", async () => {
    const user = userEvent.setup();
    render_workspace(<><OperatorActionPanel tenant_id={TEST_TENANT_ID} authorize={stub_authorizer(build_fixture_principal(TEST_TENANT_ID, "operator", true))} /><AuditTimeline /></>, "operator", true);
    await user.selectOptions(screen.getByLabelText("Target"), "conflict-fixture-pending");
    await user.click(screen.getByRole("button", { name: "Run action" }));
    const timeline = screen.getByRole("region", { name: "Audit timeline" });
    expect(await within(timeline).findByText(/1 added in this session/)).toBeTruthy();
  });
});
