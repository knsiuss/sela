"use client";

/**
 * Landmark shell shared by every workspace route.
 *
 * Accessibility contract: the skip link is the first focusable element and
 * points at `#main`; navigation, the skip link, and the environment warning all
 * live inside the `banner` landmark, so no page content sits outside a
 * landmark. A test asserts exactly that, which also pins the DOM: this component
 * may emit `<header>` and `<main>` and nothing else at the top level, so the
 * two-column layout has to come from the `body` grid rather than a wrapper.
 * Keeping this shell in a component (instead of inline in the layout) lets the
 * accessibility tests exercise the real landmarks without rendering an
 * `<html>` element.
 *
 * The theme toggle is last in the header so it sits after the navigation in
 * document order: the skip link and the six nav links are the first seven tab
 * stops, which a keyboard-navigation test asserts.
 */

import type { ReactElement, ReactNode } from "react";
import { LocalOnlyBanner } from "@repo/ui";
import type { WorkspaceSnapshot } from "@/domain/workspace_state";
import type { LocalPrincipalClaims } from "@/domain/synthetic_principal";
import { SiteNav } from "./SiteNav";
import { ThemeToggle } from "./ThemeToggle";
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
      <header role="banner" className="shell-header">
        <a className="skip-link" href="#main">Skip to main content</a>
        <SiteNav />
        <div className="site-nav__footer">
          <LocalOnlyBanner tenant_id={props.tenant_id} role={props.role} />
          <ThemeToggle />
        </div>
      </header>
      <WorkspaceProvider snapshot={props.snapshot} principal={props.principal}>
        <main id="main" className="shell-main">{props.children}</main>
      </WorkspaceProvider>
    </>
  );
}