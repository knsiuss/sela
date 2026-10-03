/**
 * Installs the request-scoped cache React uses under the App Router.
 *
 * `cache()` only memoizes while a React cache scope is active, and that scope
 * exists only inside a server render. Outside one, the client build of `cache` is
 * a plain pass-through, so a unit test cannot observe the memoization at all.
 * These helpers let a test drive React's *own* server build instead, which is the
 * behaviour the App Router actually runs, rather than a stand-in for it.
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** The per-request store React keys its cache nodes by. */
type CacheStore = Map<unknown, unknown>;

/** React's shared internals, only the async-dispatcher slot is used here. */
export interface ReactServerInternals {
  A: unknown;
}

/**
 * Resolve and load React's `react-server` build.
 *
 * @returns The server build's exports, including `cache` and its shared internals.
 */
export async function load_react_server_build(): Promise<Record<string, unknown>> {
  const entry = createRequire(import.meta.url).resolve("react");
  const url = pathToFileURL(join(dirname(entry), "react.react-server.js")).href;
  return await import(/* @vite-ignore */ url) as Record<string, unknown>;
}

/**
 * Read React's shared internals from the server build.
 *
 * @param build - Exports of React's `react-server` build.
 * @returns The internals object holding the active cache dispatcher.
 * @throws Error when the build does not expose them.
 */
export function react_server_internals(build: Record<string, unknown>): ReactServerInternals {
  const named = build["__SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE"];
  if (named === null || typeof named !== "object") throw new Error("react-server-internals-unavailable");
  return named as ReactServerInternals;
}

/**
 * Run one request-scoped block with a single cache store.
 *
 * This mirrors what React installs for a request: one store per cached function,
 * discarded when the request ends. A cached function called twice inside the block
 * is therefore called once, which is exactly the property the workspace scope
 * depends on. The store is held for the awaited result too, because a cached
 * async function is only reached again after its first caller has yielded.
 *
 * @param internals - React's shared internals from the server build.
 * @param run - Body to run inside the request scope.
 * @returns Whatever `run` resolves to.
 */
export async function in_request_scope<T>(internals: ReactServerInternals, run: () => T): Promise<T> {
  const store: CacheStore = new Map();
  const previous = internals.A;
  internals.A = { getCacheForType: () => store };
  try {
    return await run();
  } finally {
    internals.A = previous;
  }
}
