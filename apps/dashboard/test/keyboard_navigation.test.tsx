// @vitest-environment jsdom

/**
 * Keyboard operability and focus management for the workspace views.
 *
 * `user-event` performs real `Tab` traversal, so these assertions fail if a
 * control becomes unreachable, if a non-interactive element is added to the tab
 * order, or if focus is not moved to the result after a transition.
 */

import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppointmentTable } from "../src/components/AppointmentTable";
import { ConflictBoard } from "../src/components/ConflictBoard";
import { OperatorActionPanel } from "../src/components/OperatorActionPanel";
import { QueueBoard } from "../src/components/QueueBoard";
import { build_test_snapshot, render_workspace, TEST_TENANT_ID } from "./support/render_workspace.js";
import { stub_authorizer } from "./support/render_workspace.js";
import { build_fixture_principal } from "./support/fixture_principal.js";

function active_element(): HTMLElement | null {
  return document.activeElement as HTMLElement | null;
}

describe("tab order", () => {
  it("reaches the skip link before the primary navigation", async () => {
    const user = userEvent.setup();
    render_workspace(<h1>Overview</h1>);
    await user.tab();
    expect(active_element()?.getAttribute("href")).toBe("#main");
    await user.tab();
    expect(active_element()?.textContent).toBe("Overview");
  });

  it("reaches every primary navigation link in document order", async () => {
    const user = userEvent.setup();
    render_workspace(<h1>Overview</h1>);
    const labels: string[] = [];
    for (let step = 0; step < 7; step += 1) {
      await user.tab();
      labels.push(active_element()?.textContent ?? "");
    }
    expect(labels).toEqual([
      "Skip to main content", "Overview", "Appointments", "Conflicts", "Queue", "Actions", "Audit",
    ]);
  });

  it("reaches the pending conflict's propose control by tabbing alone", async () => {
    const user = userEvent.setup();
    render_workspace(<ConflictBoard tenant_id={TEST_TENANT_ID} />, "operator", true);
    const reached: string[] = [];
    for (let step = 0; step < 60; step += 1) {
      await user.tab();
      const focused = active_element();
      const action = focused?.getAttribute("data-action");
      if (action !== null && action !== undefined) reached.push(`${focused?.getAttribute("data-conflict")}:${action}`);
    }
    expect(reached).toContain("conflict-fixture-pending:propose");
    expect(reached).toContain("conflict-fixture-proposed:accept");
  });
});

describe("keyboard activation", () => {
  it("sorts the appointment table with the keyboard only", async () => {
    const user = userEvent.setup();
    render_workspace(<AppointmentTable rows={build_test_snapshot().appointments} tenant_id={TEST_TENANT_ID} />);
    const header = screen.getByRole("columnheader", { name: /^resource$/i });
    within(header).getByRole("button").focus();
    expect(active_element()?.tagName).toBe("BUTTON");
    await user.keyboard("{Enter}");
    expect(screen.getByRole("columnheader", { name: /^resource$/i }).getAttribute("aria-sort")).toBe("ascending");
  });

  it("toggles the sort direction with the space key", async () => {
    const user = userEvent.setup();
    render_workspace(<AppointmentTable rows={build_test_snapshot().appointments} tenant_id={TEST_TENANT_ID} />);
    within(screen.getByRole("columnheader", { name: /^resource$/i })).getByRole("button").focus();
    await user.keyboard(" ");
    await user.keyboard(" ");
    expect(screen.getByRole("columnheader", { name: /^resource$/i }).getAttribute("aria-sort")).toBe("descending");
  });

  it("completes a queue workflow with the keyboard only", async () => {
    const user = userEvent.setup();
    render_workspace(<QueueBoard tenant_id={TEST_TENANT_ID} />);
    const group = screen.getByRole("group", { name: "queue-fixture-unassigned" });
    within(group).getByRole("button", { name: "Resolve" }).focus();
    await user.keyboard("{Enter}");
    expect(within(screen.getByRole("group", { name: "queue-fixture-unassigned" })).getByText("Resolved")).toBeTruthy();
  });

  it("runs an operator action with the keyboard only", async () => {
    const user = userEvent.setup();
    render_workspace(<OperatorActionPanel tenant_id={TEST_TENANT_ID} authorize={stub_authorizer(build_fixture_principal(TEST_TENANT_ID, "operator", true))} />, "operator", true);
    await user.selectOptions(screen.getByLabelText("Target"), "conflict-fixture-pending");
    const submit = screen.getByRole("button", { name: "Run action" });
    submit.focus();
    expect(active_element()?.getAttribute("data-action")).toBe("submit-operator-action");
    await user.keyboard("{Enter}");
    const status = within(screen.getByRole("region", { name: "Operator actions" })).getByRole("status");
    expect(await within(status).findByText(/resolve_conflict Succeeded/)).toBeTruthy();
  });
});

describe("focus management", () => {
  it("moves focus to the status region after a conflict transition", async () => {
    const user = userEvent.setup();
    render_workspace(<ConflictBoard tenant_id={TEST_TENANT_ID} />, "operator", true);
    const group = screen.getByRole("group", { name: "conflict-fixture-pending" });
    within(group).getByRole("button", { name: "Reject" }).focus();
    await user.keyboard("{Enter}");
    const status = within(screen.getByRole("region", { name: "Conflict resolution" })).getByRole("status");
    expect(active_element()).toBe(status);
    expect(status.getAttribute("tabindex")).toBe("-1");
  });

  it("moves focus to the status region after a queue transition", async () => {
    const user = userEvent.setup();
    render_workspace(<QueueBoard tenant_id={TEST_TENANT_ID} />);
    within(screen.getByRole("group", { name: "queue-fixture-unassigned" })).getByRole("button", { name: "Assign" }).focus();
    await user.keyboard("{Enter}");
    const status = within(screen.getByRole("region", { name: "Assignment and escalation" })).getByRole("status");
    expect(active_element()).toBe(status);
  });

  it("moves focus to the status region after an operator action", async () => {
    const user = userEvent.setup();
    render_workspace(<OperatorActionPanel tenant_id={TEST_TENANT_ID} authorize={stub_authorizer(build_fixture_principal(TEST_TENANT_ID, "operator", true))} />, "operator", true);
    await user.selectOptions(screen.getByLabelText("Target"), "conflict-fixture-pending");
    await user.click(screen.getByRole("button", { name: "Run action" }));
    const status = within(screen.getByRole("region", { name: "Operator actions" })).getByRole("status");
    expect(await within(status).findByText(/resolve_conflict Succeeded/)).toBeTruthy();
    expect(active_element()).toBe(status);
  });

  it("does not steal focus on first render", () => {
    render_workspace(<ConflictBoard tenant_id={TEST_TENANT_ID} />, "operator", true);
    expect(active_element()).toBe(document.body);
  });
});

describe("no positive tabindex", () => {
  it("never puts a positive tabindex in the document", () => {
    const { container } = render_workspace(<><ConflictBoard tenant_id={TEST_TENANT_ID} /><QueueBoard tenant_id={TEST_TENANT_ID} /></>, "operator", true);
    const positive = [...container.querySelectorAll("[tabindex]")]
      .filter((node) => Number(node.getAttribute("tabindex")) > 0);
    expect(positive).toHaveLength(0);
  });
});
