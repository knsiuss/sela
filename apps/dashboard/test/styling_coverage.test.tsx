// @vitest-environment jsdom

/**
 * Every styled surface has a rule.
 *
 * The failure this guards against is a class in the markup with no matching
 * selector in the stylesheet, which renders as an unstyled default box in the
 * middle of an otherwise designed page. jsdom applies no CSS, so axe cannot catch
 * it and neither can a type check; only this comparison can.
 */

import { describe, expect, it } from "vitest";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import type { ReactElement } from "react";
import { AppointmentTable } from "../src/components/AppointmentTable";
import { AuditTimeline } from "../src/components/AuditTimeline";
import { ConflictBoard } from "../src/components/ConflictBoard";
import { OperatorActionPanel } from "../src/components/OperatorActionPanel";
import { QueueBoard } from "../src/components/QueueBoard";
import OverviewPage from "../src/app/page";
import { build_test_snapshot, render_workspace, TEST_TENANT_ID } from "./support/render_workspace.js";

const STYLE_LAYERS: readonly string[] = [
  "src/styles/base.css",
  "src/styles/layout.css",
  "src/styles/components.css",
  "src/styles/data.css",
];

/** Every route view plus the shell, so the whole workspace is covered. */
const VIEWS: Readonly<Record<string, () => ReactElement>> = {
  overview: () => <OverviewPage />,
  appointments: () => <AppointmentTable rows={build_test_snapshot().appointments} tenant_id={TEST_TENANT_ID} />,
  conflicts: () => <ConflictBoard tenant_id={TEST_TENANT_ID} />,
  queue: () => <QueueBoard tenant_id={TEST_TENANT_ID} />,
  actions: () => <OperatorActionPanel tenant_id={TEST_TENANT_ID} />,
  audit: () => <AuditTimeline />,
};

function read_stylesheet(relative_path: string): string {
  let current = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      return readFileSync(resolve(current, relative_path), "utf8");
    } catch {
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  throw new Error(`dashboard-test-file-missing:${relative_path}`);
}

/** Drop every declaration block, leaving only selectors and at-rules. */
function strip_declarations(source: string): string {
  const pattern = /\{[^{}]*\}/gu;
  let current = source.replace(/\/\*[\s\S]*?\*\//gu, "");
  while (pattern.test(current)) {
    pattern.lastIndex = 0;
    current = current.replace(pattern, "");
  }
  return current;
}

/**
 * Class names the stylesheets define.
 *
 * Declaration blocks are stripped before scanning so a decimal value such as
 * `0.5rem` cannot masquerade as a class name, and the whole selector text is
 * scanned rather than just its first token so that `.data-table .cell--numeric`
 * registers `cell--numeric` as defined.
 */
function styled_classes(): Set<string> {
  const defined = new Set<string>();
  for (const layer of STYLE_LAYERS) {
    for (const match of strip_declarations(read_stylesheet(layer)).matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/gu)) {
      defined.add(match[1]);
    }
  }
  return defined;
}

function rendered_classes(root: ParentNode): Set<string> {
  const used = new Set<string>();
  for (const node of root.querySelectorAll("[class]")) {
    for (const name of node.classList) used.add(name);
  }
  return used;
}

describe("styling coverage", () => {
  const defined = styled_classes();

  for (const [name, render] of Object.entries(VIEWS)) {
    it(`styles every surface on the ${name} view`, () => {
      const { container } = render_workspace(render());
      const used = rendered_classes(container);
      expect(used.size, `${name} should render styled surfaces`).toBeGreaterThan(0);
      expect([...used].filter((class_name) => !defined.has(class_name)).sort()).toEqual([]);
    });
  }

  it("keeps the shell, navigation, and theme toggle styled too", () => {
    const { container } = render_workspace(<h1>Workspace</h1>);
    const used = rendered_classes(container);
    for (const expected of ["shell-header", "skip-link", "site-nav", "site-nav__list", "site-nav__link", "banner", "theme-toggle", "shell-main"]) {
      expect(used.has(expected), `shell is missing ${expected}`).toBe(true);
    }
    expect([...used].filter((class_name) => !defined.has(class_name)).sort()).toEqual([]);
  });

  it("defines every tone variant the status map can produce", () => {
    for (const tone of ["neutral", "positive", "warning", "critical"]) {
      expect(defined.has(`badge--${tone}`), `badge--${tone} must be styled`).toBe(true);
    }
  });

  it("styles every card accent the boards can produce", () => {
    for (const status of ["unassigned", "assigned", "escalated", "resolved", "pending", "proposed", "accepted", "rejected", "expired"]) {
      // Selectors may be grouped, so accept either this status closing the block
      // or being followed by more selectors in the same rule.
      const rule = new RegExp(`\\.card\\[data-card-status="${status}"\\][^{]*\\{[^}]*--card-accent`, "u");
      expect(STYLE_LAYERS.some((layer) => rule.test(read_stylesheet(layer))), `${status} needs a card accent`).toBe(true);
    }
  });
});