import type { Metadata } from "next";
import type { ReactElement, ReactNode } from "react";
import "./globals.css";
import { AppShell } from "@/components/AppShell";
import { load_local_scope } from "./local_scope";

const METADATA: Metadata = {
  title: "Operator workspace (local only)",
  description: "Local, unauthenticated operator workspace for the appointment agent.",
  robots: { index: false, follow: false },
};

/** Props for the root layout; Next supplies them. */
export interface RootLayoutProps {
  children: ReactNode;
}

/**
 * Render the document shell and hand the workspace state to {@link AppShell}.
 *
 * @param props - Page content supplied by the router.
 * @returns The root layout element.
 */
export default function RootLayout(props: RootLayoutProps): ReactElement {
  const scope = load_local_scope();
  return (
    <html lang="en">
      <body>
        <AppShell
          tenant_id={scope.tenant_id}
          role={scope.role}
          snapshot={scope.snapshot}
          principal={scope.principal}
        >
          {props.children}
        </AppShell>
      </body>
    </html>
  );
}