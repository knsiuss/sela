// @vitest-environment jsdom

/**
 * Automated accessibility assertions for every workspace view.
 *
 * `axe-core` covers the machine-checkable rules; the explicit assertions cover
 * the contracts axe cannot see, such as the skip-link target, a single `h1`,
 * `aria-sort` on every sortable column, and an associated reason for every
 * disabled control.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import type { ReactElement } from "react";
import { AppointmentTable } from "../src/components/AppointmentTable";
import { AuditTimeline } from "../src/components/AuditTimeline";
import { ConflictBoard } from "../src/components/ConflictBoard";
import { OperatorActionPanel } from "../src/components/OperatorActionPanel";
import { QueueBoard } from "../src/components/QueueBoard";
import { build_test_snapshot, render_workspace, TEST_TENANT_ID } from "./support/render_workspace.js";

interface ViewCase {
  name: string;
  render: () => ReactElement;
}

const VIEW_CASES: readonly ViewCase[] = [
  {
    name: "appointments",
    render: () => <><h1>Appointments</h1><AppointmentTable rows={build_test_snapshot().appointments} tenant_id={TEST_TENANT_ID} /></>,
  },
  { name: "conflicts", render: () => <><h1>Conflicts</h1><ConflictBoard tenant_id={TEST_TENANT_ID} /></> },
  { name: "queue", render: () => <><h1>Queue</h1><QueueBoard tenant_id={TEST_TENANT_ID} /></> },
  { name: "actions", render: () => <><h1>Actions</h1><OperatorActionPanel tenant_id={TEST_TENANT_ID} /></> },
  { name: "audit", render: () => <><h1>Audit</h1><AuditTimeline /></> },
];

function ids_of_violations(result: axe.AxeResults): string[] {
  return result.violations.map((violation) => `${violation.id}: ${violation.nodes.length}`);
}

/**
 * Resolve a file inside this package regardless of the launch directory.
 *
 * Vitest rewrites `import.meta.url` to an http URL under jsdom, so the search
 * walks up from the working directory instead of relying on module location.
 *
 * @param relative_path - Path relative to the package root.
 * @returns Absolute path to the file.
 * @throws Error When the file is not found, so a typo cannot pass silently.
 */
function find_package_file(relative_path: string): string {
  let current = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = resolve(current, relative_path);
    if (readFileSafe(candidate) !== null) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`dashboard-test-file-missing:${relative_path}`);
}

function readFileSafe(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

describe("axe-core rule coverage", () => {
  for (const view_case of VIEW_CASES) {
    it(`reports no violations on the ${view_case.name} view`, async () => {
      render_workspace(view_case.render());
      const results = await axe.run(document.body);
      expect(ids_of_violations(results)).toEqual([]);
    });
  }
});

describe("landmarks and headings", () => {
  for (const view_case of VIEW_CASES) {
    it(`exposes one main landmark and one h1 on the ${view_case.name} view`, () => {
      render_workspace(view_case.render());
      expect(screen.getAllByRole("main")).toHaveLength(1);
      expect(document.querySelectorAll("h1")).toHaveLength(1);
      expect(screen.getByRole("navigation", { name: "Primary" })).toBeTruthy();
    });
  }

  it("puts the skip link first in the tab order and points it at main", () => {
    render_workspace(<h1>Overview</h1>);
    const links = screen.getAllByRole("link");
    expect(links[0].getAttribute("href")).toBe("#main");
    expect(document.querySelector("main#main")).toBeTruthy();
  });

  it("keeps every rendered element inside a landmark", () => {
    const { container } = render_workspace(<h1>Overview</h1>);
    const outside = [...container.querySelectorAll("*")].filter((node) =>
      node.closest("header, main, nav") === null);
    expect(outside).toHaveLength(0);
  });

  it("marks the active navigation item with aria-current", () => {
    render_workspace(<h1>Queue</h1>);
    expect(screen.getByRole("link", { name: "Queue" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Overview" }).getAttribute("aria-current")).toBeNull();
  });

  it("keeps the skip link, navigation, and warning inside the banner landmark", () => {
    render_workspace(<h1>Overview</h1>);
    expect(screen.getByRole("note", { name: "Environment warning" }).closest("header")).toBeTruthy();
  });

  it("declares the document language in the root layout", () => {
    // jsdom renders the shell, not `<html>`, so the `lang` attribute is asserted
    // against the layout source that Next uses for the real document.
    const layout_path = find_package_file("src/app/layout.tsx");
    expect(readFileSync(layout_path, "utf8")).toContain('<html lang="en">');
  });
});

describe("table semantics", () => {
  it("gives the appointment table a caption and a scope on every column header", () => {
    render_workspace(<AppointmentTable rows={build_test_snapshot().appointments} tenant_id={TEST_TENANT_ID} />);
    expect(document.querySelector("table caption")).toBeTruthy();
    for (const header of screen.getAllByRole("columnheader")) {
      expect(header.getAttribute("scope")).toBe("col");
      expect(header.getAttribute("aria-sort")).not.toBeNull();
    }
  });

  it("offers a real button inside each sortable column header", () => {
    render_workspace(<AppointmentTable rows={build_test_snapshot().appointments} tenant_id={TEST_TENANT_ID} />);
    for (const header of screen.getAllByRole("columnheader")) {
      expect(within(header).getByRole("button")).toBeTruthy();
    }
  });
});

describe("disabled control explanations", () => {
  it("associates a visible reason with every disabled conflict action", () => {
    render_workspace(<ConflictBoard tenant_id={TEST_TENANT_ID} />);
    const disabled = screen.getAllByRole("button").filter((button) => (button as HTMLButtonElement).disabled);
    expect(disabled.length).toBeGreaterThan(0);
    for (const button of disabled) {
      const described_by = button.getAttribute("aria-describedby");
      expect(described_by).not.toBeNull();
      const hint = document.getElementById(described_by ?? "");
      expect(hint?.textContent ?? "").not.toBe("");
    }
  });

  it("associates a visible reason with a blocked operator action", async () => {
    const user = userEvent.setup();
    render_workspace(<OperatorActionPanel tenant_id={TEST_TENANT_ID} />);
    const allowed = screen.getByRole("button", { name: "Run action" });
    expect((allowed as HTMLButtonElement).disabled).toBe(false);
    expect(allowed.getAttribute("aria-describedby")).toBeNull();

    await user.selectOptions(screen.getByLabelText("Action"), "replay_outbound");
    const blocked = screen.getByRole("button", { name: "Run action" });
    expect((blocked as HTMLButtonElement).disabled).toBe(true);
    const hint = document.getElementById(blocked.getAttribute("aria-describedby") ?? "");
    expect(hint?.textContent ?? "").toContain("forbidden");
  });
});

describe("status is never conveyed by colour alone", () => {
  it("renders a text label beside every status badge", () => {
    render_workspace(<ConflictBoard tenant_id={TEST_TENANT_ID} />);
    const badges = document.querySelectorAll("[data-status]");
    expect(badges.length).toBeGreaterThan(0);
    for (const badge of badges) {
      expect((badge.textContent ?? "").trim().length).toBeGreaterThan(0);
    }
  });
});