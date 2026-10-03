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
import { build_fixture_claims, build_fixture_principal } from "./fixture_principal";
import { authorize_operator_action } from "../../src/domain/action_receipt";
import type { AuthenticatedPrincipal, EnterpriseRole } from "appointment-agent/dist/src/enterprise/authorization.js";
import type { ActionAuthorizer } from "../../src/components/use_operator_action";
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
 * Build a stand-in for the server authorization action.
 *
 * The stub runs the *same* pure authorization contract the server action uses,
 * against the same fixture principal, so it can never authorize something the
 * server would refuse. Only the HMAC receipt is omitted, because signing belongs
 * to the server and the receipt is consumed server-side.
 *
 * @param principal - Fixture principal the stub authorizes as.
 * @returns An authorizer for {@link OperatorActionPanel}.
 */
export function stub_authorizer(principal: AuthenticatedPrincipal): ActionAuthorizer {
  return async (request) => {
    const privileged = request.action === "replay_outbound";
    const code = authorize_operator_action(principal, request, privileged);
    return { code, receipt: code === null ? "fixture-receipt" : null };
  };
}

/**
 * Render one workspace view inside the real application shell.
 *
 * `has_mfa` defaults to `false` because that is what a session without a verified
 * second factor looks like. A test that exercises an MFA-gated action must pass
 * `true` explicitly, which keeps the privileged path visible in the test source
 * instead of being an ambient property of the fixture.
 *
 * @param view - View component to render as the page content.
 * @param role - Role the fixture principal holds in the tenant.
 * @param has_mfa - Whether the fixture principal simulates a verified second factor.
 * @returns Render result plus the snapshot the view started from.
 */
export function render_workspace(
  view: ReactElement,
  role: EnterpriseRole = "operator",
  has_mfa = false,
): WorkspaceRender {
  const snapshot = build_test_snapshot(role);
  const result = render(
    <AppShell
      tenant_id={TEST_TENANT_ID}
      role={role}
      snapshot={snapshot}
      principal={build_fixture_claims(TEST_TENANT_ID, role, has_mfa)}
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