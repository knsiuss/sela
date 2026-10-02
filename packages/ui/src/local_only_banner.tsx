/**
 * Standing local-only warning shown by every local surface in this repository.
 *
 * SECURITY (P2.2): this build has no authentication. The wording is
 * deliberate and must not be softened while auth is outstanding, because the
 * operator is the only thing keeping tenant scope honest right now.
 *
 * It lives in `@repo/ui` rather than in one app because two unauthenticated
 * local surfaces now render it: the operator dashboard and the end-user chat
 * client. A second copy of this copy would let the two framings drift, and a
 * softened variant is exactly the failure this component exists to prevent.
 * The class names are part of the contract with each surface's stylesheet and
 * with the dashboard's landmark and styling-coverage tests, so they are
 * reproduced verbatim rather than renamed to a shared token.
 */

import type { ReactElement } from "react";

/** Props for {@link LocalOnlyBanner}. */
export interface LocalOnlyBannerProps {
  tenant_id: string;
  role: string;
}

/**
 * Render the local-only, no-auth, synthetic-data notice.
 *
 * @param props - Resolved local tenant and role.
 * @returns The banner element.
 */
export function LocalOnlyBanner(props: LocalOnlyBannerProps): ReactElement {
  return (
    <aside className="banner" role="note" aria-label="Environment warning">
      <p className="banner__title">Local development build. No authentication.</p>
      <ul className="banner__list">
        <li>All records are synthetic fixtures. There is no customer data in this build.</li>
        <li>
          Tenant scope is fixed on the server to <strong>{props.tenant_id}</strong> with the{" "}
          <strong>{props.role}</strong> role. The browser cannot change either value.
        </li>
        <li>
          Do not expose this interface beyond localhost until appointment-agent server wiring,
          database row-level security, and OIDC authentication land.
        </li>
      </ul>
    </aside>
  );
}
