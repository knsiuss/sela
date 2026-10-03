/**
 * The minimal fetch shape the staff-auth modules depend on.
 *
 * Declared here rather than imported from a provider package: the staff-auth
 * modules are consumed by the dashboard's bundler, which cannot follow the
 * Calendar package's NodeNext source specifiers, and a type-only import would
 * still couple this module's build order to that package's output.
 */

/** A `fetch`-compatible transport, replaceable by a test double. */
export type OAuthFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
