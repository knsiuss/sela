import type { ReactElement } from "react";
import { OverviewView } from "@/components/OverviewView";
import { load_workspace_scope } from "./local_scope";

/**
 * Route wrapper for the overview.
 *
 * The only thing this file owns is the authenticated session: it resolves the
 * principal, then hands the resulting scope to the presentational overview. With
 * no session the call throws and the root layout renders the sign-in notice, so
 * an unauthenticated request never reaches operator data.
 *
 * @returns The overview page.
 */
export default async function OverviewPage(): Promise<ReactElement> {
  const scope = await load_workspace_scope();
  return <OverviewView scope={scope} />;
}
