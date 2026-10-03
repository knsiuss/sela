/**
 * Next.js configuration for the operator dashboard.
 *
 * SECURITY: the dashboard now authenticates staff through an OAuth
 * authorization-code flow and refuses to render without a verified session, but
 * it still executes operator actions against local in-memory fixtures from the
 * browser. Per the P2.2 audit it therefore must not be exposed beyond local
 * development: the `dev`/`start` scripts pin the bind to 127.0.0.1 and nothing
 * here may add a 0.0.0.0 bind, a public `hostname`, or a tunnel. The remaining
 * gap is server-owned data with row-level security, not authentication.
 */

/** @type {import("next").NextConfig} */
const next_config = {
  reactStrictMode: true,
  // Next 16 writes AGENTS.md and CLAUDE.md into the app by default. This repo
  // keeps agent guidance in the root AGENTS.md, so the generated copies are
  // disabled rather than left behind as untracked files.
  agentRules: false,
  // No remote sources are needed: every surface renders local data, so the
  // image/content remote allowlists stay empty on purpose.
  poweredByHeader: false,
};

export default next_config;