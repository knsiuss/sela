// @vitest-environment jsdom

/**
 * PII minimisation guarantees for the operator workspace.
 *
 * P2.2 requires a redacted operator context, so these assertions treat "no
 * customer content in any payload or rendered surface" as a contract that must
 * fail loudly rather than a review note.
 */

import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppointmentTable } from "../src/components/AppointmentTable";
import { AuditTimeline } from "../src/components/AuditTimeline";
import { ConflictBoard } from "../src/components/ConflictBoard";
import { OperatorActionPanel } from "../src/components/OperatorActionPanel";
import { QueueBoard } from "../src/components/QueueBoard";
import { build_audit_timeline } from "../src/domain/audit_timeline.js";
import type { StampedAuditRecord } from "../src/domain/operator_action_gateway.js";
import { build_test_snapshot, render_workspace, TEST_TENANT_ID } from "./support/render_workspace.js";
import { stub_authorizer } from "./support/render_workspace.js";
import { build_fixture_principal } from "./support/fixture_principal.js";

/** Field names that must never appear in a dashboard payload. */
const FORBIDDEN_KEYS = [
  "email", "phone", "phone_number", "name", "customer_name", "patient_name", "full_name",
  "body", "text", "text_body", "message", "message_text", "raw_message", "transcript", "reason",
];

/** Only these keys may exist on an appointment row in the client payload. */
const APPOINTMENT_KEYS = [
  "appointment_id", "ends_at_iso", "resource_id", "starts_at_iso", "status", "tenant_id", "version",
];

function collect_keys(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((entry, index) => collect_keys(entry, `${path}[${index}]`));
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, entry]) => [`${path === "" ? "" : `${path}.`}${key}`, ...collect_keys(entry, `${path === "" ? "" : `${path}.`}${key}`)]);
}

function expect_no_forbidden_keys(value: unknown): void {
  for (const path of collect_keys(value)) {
    const leaf = path.split(".").pop() ?? "";
    expect(FORBIDDEN_KEYS).not.toContain(leaf);
  }
}

describe("client payload", () => {
  it("exposes only the approved appointment fields", () => {
    const snapshot = build_test_snapshot();
    expect(Object.keys(snapshot.appointments[0]).sort()).toEqual(APPOINTMENT_KEYS);
  });

  it("carries no forbidden key on any snapshot slice", () => {
    expect_no_forbidden_keys(build_test_snapshot());
  });

  it("carries no forbidden key on a built audit timeline", () => {
    const rows: StampedAuditRecord[] = [{
      tenant_id: TEST_TENANT_ID,
      actor_subject: "fixture-operator",
      action: "resolve_conflict",
      target_id: "conflict-fixture-pending",
      outcome: "succeeded",
      request_id: "req-1",
      reason_code: "operator_verified",
      at_iso: "2026-03-02T09:05:00.000Z",
    }];
    const entries = build_audit_timeline(rows, TEST_TENANT_ID);
    expect(collect_keys(entries).map((path) => path.split(".").pop() ?? "")).not.toContain("reason_text");
    expect(Object.keys(entries[0])).not.toContain("reason");
  });

  it("keeps foreign-tenant rows out of the snapshot entirely", () => {
    const snapshot = build_test_snapshot();
    expect(snapshot.appointments.every((row) => row.tenant_id === TEST_TENANT_ID)).toBe(true);
    expect(snapshot.hidden_by_tenant_scope).toBeGreaterThan(0);
  });
});

describe("rendered surfaces", () => {
  it("renders no phone-shaped value in any view", () => {
    const snapshot = build_test_snapshot();
    const { container } = render_workspace(
      <><h1>Workspace</h1>
        <AppointmentTable rows={snapshot.appointments} tenant_id={TEST_TENANT_ID} />
        <ConflictBoard tenant_id={TEST_TENANT_ID} />
        <QueueBoard tenant_id={TEST_TENANT_ID} />
        <OperatorActionPanel tenant_id={TEST_TENANT_ID} authorize={stub_authorizer(build_fixture_principal(TEST_TENANT_ID, "operator", true))} />
        <AuditTimeline />
      </>,
    );
    const text = leaf_text(container);
    // Digit runs of four or more are what the repository's own handoff
    // redaction treats as phone numbers or confirmation codes. Timestamps and
    // the server-resolved tenant id are the only sanctioned exceptions: the
    // first is a fixed-width date, the second is an operator-scope identifier
    // that the domain itself defines as numeric.
    const scrubbed = text
      .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/gu, "")
      .replace(new RegExp(TEST_TENANT_ID, "gu"), "tenant");
    expect(scrubbed.match(/\d{4,}/gu) ?? []).toEqual([]);
  });

  it("renders no free-text reason input on the action surface", () => {
    render_workspace(<OperatorActionPanel tenant_id={TEST_TENANT_ID} authorize={stub_authorizer(build_fixture_principal(TEST_TENANT_ID, "operator", true))} />);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("combobox", { name: /reason text/i })).toBeNull();
  });

  it("renders only bounded reason codes for escalation", () => {
    render_workspace(<QueueBoard tenant_id={TEST_TENANT_ID} />);
    const group = screen.getByRole("group", { name: "queue-fixture-escalated" });
    const options = within(group).getByLabelText("Escalation reason code");
    for (const option of within(options).getAllByRole("option")) {
      expect((option.textContent ?? "").match(/^[a-z0-9_]{1,64}$/u)).not.toBeNull();
    }
  });

  it("keeps the submitted reason out of the audit timeline", async () => {
    const user = userEvent.setup();
    render_workspace(<><h1>Actions</h1><OperatorActionPanel tenant_id={TEST_TENANT_ID} authorize={stub_authorizer(build_fixture_principal(TEST_TENANT_ID, "operator", true))} /><AuditTimeline /></>, "operator", true);
    await user.selectOptions(screen.getByLabelText("Target"), "conflict-fixture-pending");
    await user.click(screen.getByRole("button", { name: "Run action" }));
    const timeline = screen.getByRole("region", { name: "Audit timeline" });
    await within(timeline).findByRole("listitem");
    expect(text_of(timeline)).toContain("Reason code");
    expect(text_of(timeline)).not.toContain("POST /v1/operator/actions");
  });

  it("states the no-auth, local-only posture on every page", () => {
    render_workspace(<h1>Overview</h1>);
    const banner = screen.getByRole("note", { name: "Environment warning" });
    expect(text_of(banner)).toContain("No authentication");
    expect(text_of(banner)).toContain("row-level security");
    expect(text_of(banner)).toContain(TEST_TENANT_ID);
  });
});

function text_of(element: HTMLElement): string {
  return element.textContent ?? "";
}

/** Join the text of every leaf element so adjacent cells cannot concatenate. */
function leaf_text(root: HTMLElement): string {
  return [...root.querySelectorAll("*")]
    .filter((node) => node.children.length === 0)
    .map((node) => `${node.textContent ?? ""}\n`)
    .join("");
}
