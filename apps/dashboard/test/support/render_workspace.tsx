/**
 * Shared rendering helper for the workspace view tests.
 *
 * The AppShell is the real component the router uses, so landmark, focus, and
 * ARIA assertions in these tests exercise production markup rather than a
 * test-only approximation. Next's router hooks are mocked because jsdom has no
 * app router.
 */

import type { ReactElement, ReactNode } from "react";
import { render, type RenderResult } from "@testing-library/react";
import { vi } from "vitest";
import { AppShell } from "../../src/components/AppShell";
import { create_workspace_fixture } from "../../src/domain/fixtures";
import { build_local_principal, to_wire_principal } from "../../src/domain/synthetic_principal";
import type { EnterpriseRole } from "appointment-agent/dist/src/enterprise/authorization.js";
import { create_workspace_snapshot, type WorkspaceSnapshot } from "../../src/domain/workspace_state";

vi.mock("next/navigation", () => ({ usePathname: () => "/queue" }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

/** Tenant every workspace test runs under. */
export const TEST_TENANT_ID = "1001";

/** Fixed reference time so SLA rendering is deterministic. */
export const TEST_NOW_MS = Date.parse("2026-03-02T09:00:00.000Z");

/** Everything a test needs after rendering a view. */
export interface WorkspaceRender extends RenderResult {
  snapshot: WorkspaceSnapshot;
}

/**
 * Build the deterministic snapshot without rendering, for prop-driven views.
 *
 * @param role - Local synthetic role for the acting principal.
 * @returns Snapshot built from the fixed reference time.
 */
export function build_test_snapshot(role: EnterpriseRole = "operator"): WorkspaceSnapshot {
  return create_workspace_snapshot(create_workspace_fixture(TEST_NOW_MS), TEST_TENANT_ID, TEST_NOW_MS);
}

/**
 * Render one workspace view inside the real application shell.
 *
 * @param view - View component to render as the page content.
 * @param role - Local synthetic role for the acting principal.
 * @returns Render result plus the snapshot the view started from.
 */
export function render_workspace(view: ReactElement, role: EnterpriseRole = "operator"): WorkspaceRender {
  const snapshot = build_test_snapshot(role);
  const result = render(
    <AppShell
      tenant_id={TEST_TENANT_ID}
      role={role}
      snapshot={snapshot}
      principal={to_wire_principal(build_local_principal(TEST_TENANT_ID, role))}
    >
      {view}
    </AppShell>,
  );
  return { ...result, snapshot };
}

/** Find one synthetic record by id, failing the test loudly when it is absent. */
export function require_conflict(snapshot: WorkspaceSnapshot, conflict_id: string) {
  const found = snapshot.conflicts.find((record) => record.conflict_id === conflict_id);
  if (found === undefined) throw new Error(`fixture-missing-conflict-${conflict_id}`);
  return found;
}

/** Find one synthetic queue item by id, failing the test loudly when absent. */
export function require_queue_item(snapshot: WorkspaceSnapshot, item_id: string) {
  const found = snapshot.queue_items.find((item) => item.item_id === item_id);
  if (found === undefined) throw new Error(`fixture-missing-queue-item-${item_id}`);
  return found;
}