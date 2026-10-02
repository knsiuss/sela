/**
 * Next.js configuration for the local-only operator dashboard.
 *
 * SECURITY: this dashboard has no authentication yet (P2.2). It is only ever
 * started on loopback (see the `dev`/`start` scripts, which pass -H 127.0.0.1)
 * and must not be exposed beyond local development until the appointment-agent
 * server wiring, row-level security, and the OIDC authentication path land.
 * Nothing here may add a 0.0.0.0 bind, a public `hostname`, or a tunnel.
 */

/** @type {import("next").NextConfig} */
const next_config = {
  reactStrictMode: true,
  // Next 16 writes AGENTS.md and CLAUDE.md into the app by default. This repo
  // keeps agent guidance in the root AGENTS.md, so the generated copies are
  // disabled rather than left behind as untracked files.
  agentRules: false,
  // No remote sources are needed: every surface renders local synthetic data,
  // so the image/content remote allowlists stay empty on purpose.
  poweredByHeader: false,
};

export default next_config;