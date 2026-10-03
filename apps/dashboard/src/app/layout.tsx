import type { Metadata, Viewport } from "next";
import type { ReactElement, ReactNode } from "react";
import "./globals.css";
import { AppShell } from "@/components/AppShell";
import { AuthRequiredNotice } from "@/components/AuthRequiredNotice";
import { load_workspace_scope } from "./local_scope";
import { optional_session_principal } from "./auth/session";

/**
 * The workspace is rendered only for an authenticated staff session. Reading the
 * session cookie makes every route dynamic on purpose: a prerendered dashboard
 * would be an unauthenticated dashboard, which is precisely what this change
 * removes.
 */
export const dynamic = "force-dynamic";

const METADATA: Metadata = {
  title: "Operator workspace",
  description: "Authenticated operator workspace for the appointment agent.",
  robots: { index: false, follow: false },
};

/*
 * Declares that both colour schemes are supported before the stylesheet loads,
 * so the browser paints the correct canvas colour rather than flashing white.
 * The token layer resolves every colour from this, and the in-app toggle can
 * override it per operator.
 */
const viewport: Viewport = {
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f6f8" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0e14" },
  ],
};

export { viewport };

/** Props for the root layout; Next supplies them. */
export interface RootLayoutProps {
  children: ReactNode;
}

/**
 * Render the document shell, requiring a verified staff session.
 *
 * @param props - Page content supplied by the router.
 * @returns The root layout element, or a refusal when no session is present.
 */
export default async function RootLayout(props: RootLayoutProps): Promise<ReactElement> {
  const principal = await optional_session_principal();
  if (principal === null) {
    return (
      <html lang="en">
        <body>
          <AuthRequiredNotice />
        </body>
      </html>
    );
  }
  const scope = await load_workspace_scope();
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
