import type { ReactElement } from "react";

/**
 * Rendered instead of the workspace when no verified staff session is present.
 *
 * This is the fail-closed landing page. It exists because the previous layout
 * rendered a synthetic principal with `has_mfa: true`, which meant the dashboard
 * was fully usable on localhost with no identity provider at all. Nothing is
 * rendered from the workspace here: no tenant, no role, no snapshot, and no
 * navigation, so an unauthenticated caller learns only that they must sign in.
 *
 * No query parameter can change this outcome. The link is built from a fixed
 * provider and return path rather than from anything the request supplied.
 */

/** One sign-in choice; the label is the only text on the page. */
interface SignInChoice {
  idp: "supabase" | "google";
  label: string;
}

const CHOICES: readonly SignInChoice[] = [
  { idp: "supabase", label: "Sign in with Supabase Auth" },
  { idp: "google", label: "Sign in with Google" },
];

/**
 * Render the sign-in prompt.
 *
 * @returns The refusal element.
 */
export function AuthRequiredNotice(): ReactElement {
  return (
    <main id="main" className="shell-main">
      <h1>Sign in required</h1>
      <p>
        The operator workspace is only available to an authenticated staff session. No operator data is
        shown until an identity provider verifies who you are.
      </p>
      <ul>
        {CHOICES.map((choice) => (
          <li key={choice.idp}>
            <a href={`/auth/login?idp=${choice.idp}&return_path=/actions`}>{choice.label}</a>
          </li>
        ))}
      </ul>
      <p>
        If no option works, this deployment has no identity provider configured. Set the staff
        authentication environment variables and restart; the workspace stays closed until then.
      </p>
    </main>
  );
}