"use client";

/**
 * Landmark shell shared by every workspace route.
 *
 * Accessibility contract: the skip link is the first focusable element and
 * points at `#main`; navigation, the skip link, and the environment warning all
 * live inside the `banner` landmark, so no page content sits outside a
 * landmark. Keeping this shell in a component (instead of inline in the layout)
 * lets the accessibility tests exercise the real landmarks without rendering an
 * `<html>` element.
 */

import type { ReactElement, ReactNode } from "react";
import type { WorkspaceSnapshot } from "@/domain/workspace_state";
import type { LocalPrincipalClaims } from "@/domain/synthetic_principal";
import { LocalOnlyBanner } from "./LocalOnlyBanner";
import { SiteNav } from "./SiteNav";
import { WorkspaceProvider } from "./WorkspaceProvider";

/** Props for {@link AppShell}. */
export interface AppShellProps {
  tenant_id: string;
  role: string;
  snapshot: WorkspaceSnapshot;
  principal: LocalPrincipalClaims;
  children: ReactNode;
}

/**
 * Render the skip link, navigation, warning banner, and main landmark.
 *
 * @param props - Local scope, initial workspace state, and page content.
 * @returns The shell element.
 */
export function AppShell(props: AppShellProps): ReactElement {
  return (
    <>
      <header role="banner">
        <a className="skip-link" href="#main">Skip to main content</a>
        <SiteNav />
        <LocalOnlyBanner tenant_id={props.tenant_id} role={props.role} />
      </header>
      <WorkspaceProvider snapshot={props.snapshot} principal={props.principal}>
        <main id="main">{props.children}</main>
      </WorkspaceProvider>
    </>
  );
}