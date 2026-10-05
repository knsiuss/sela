/**
 * Store selection for the staff-auth composition root.
 *
 * `runtime()` used to construct the in-memory state, session, and grant stores
 * unconditionally. That made the deployment's topology an implicit consequence of
 * the composition root rather than a decision, and it had two consequences worth
 * naming:
 *
 * - Horizontally scaled, a callback routinely lands on a different instance than
 *   the authorize request, and a state store that cannot see it answers
 *   `oauth_state_unknown`. The login simply never completes, with no error an
 *   operator can act on.
 * - Every tenant's encrypted Google refresh token lived in one process's heap, so
 *   a restart or a redeploy silently destroyed it, and the audit trail recorded no
 *   event for the loss because nothing in the application knew it had happened.
 *
 * The seam here is the seam those facts call for: a factory the composition root
 * calls, which returns ports. The in-memory implementation keeps its loopback-only
 * restriction, because that restriction is what stops a single-process store from
 * being published as if it were a shared one; the Postgres implementation lifts it
 * because a shared store is exactly what makes a multi-instance deployment correct.
 *
 * The Postgres path is UNPROVEN against a live database in this repository. The
 * pooler answers `tenant/user not found` here, so its adapters are exercised only
 * against test doubles. Selecting them in production is therefore a decision to
 * verify during rollout, not something this repository has proven.
 */

import { GoogleTokenGrantStore } from "appointment-agent/dist/src/enterprise/google_token_grants.js";
import { PostgresGoogleTokenGrantRepository } from "appointment-agent/dist/src/enterprise/postgres_google_token_grant_repository.js";
import {
  InMemoryOAuthStateStore,
  InMemoryStaffSessionStore,
  OAuthFlowError,
  is_loopback_public_base_url,
  parse_staff_directory,
} from "appointment-agent/dist/src/enterprise/oauth/index.js";
import { PostgresOAuthStateStore } from "appointment-agent/dist/src/enterprise/oauth/postgres_oauth_state_store.js";
import { PostgresStaffSessionStore } from "appointment-agent/dist/src/enterprise/oauth/postgres_staff_session_store.js";
import { load_pg_config, PgSqlClient } from "appointment-agent/dist/src/persistence/pg_client.js";
import { create_tenant_secret_cipher } from "appointment-agent/dist/src/security/tenant_secret_cipher.js";
import { google_grant_revoker } from "appointment-agent/dist/src/enterprise/oauth/index.js";
import type { MetricsSink } from "appointment-agent/dist/src/observability/metrics.js";
import type { OAuthAuditSink, StaffAuthConfig, StaffDirectory, StaffSessionStore, OAuthStateStore } from "appointment-agent/dist/src/enterprise/oauth/index.js";
import type { RecipientKeyRing } from "appointment-agent/dist/src/security/recipient_key_ring.js";

/** Everything the routes need from the stores, plus what they are made of. */
export interface StaffAuthStores {
  state_store: OAuthStateStore;
  session_store: StaffSessionStore;
  directory: StaffDirectory;
  grants: GoogleTokenGrantStore;
  /**
   * Which topology was composed.
   *
   * This is not diagnostic metadata: `assert_store_topology` reads it to decide
   * whether the loopback restriction applies, so a deployment cannot claim a
   * shared store it did not actually build.
   */
  kind: "in_memory" | "shared";
}

/** Everything a factory needs to build the stores. */
export interface StaffAuthStoreContext {
  config: StaffAuthConfig;
  env: Record<string, string | undefined>;
  ring: RecipientKeyRing;
  audit: OAuthAuditSink;
  metrics: MetricsSink;
}

/** Builds the auth stores for one deployment. */
export type StaffAuthStoreFactory = (context: StaffAuthStoreContext) => StaffAuthStores;

/**
 * Build the process-local stores.
 *
 * Correct only while one process serves every route. This is the default because
 * local development must work without a database, and it is fenced by
 * `assert_store_topology` rather than trusted.
 *
 * @param context - Configuration, key ring, audit sink, and metrics.
 * @returns Process-local stores.
 */
export function in_memory_stores(context: StaffAuthStoreContext): StaffAuthStores {
  const { audit, metrics, ring, env } = context;
  return {
    state_store: new InMemoryOAuthStateStore(),
    session_store: new InMemoryStaffSessionStore(),
    directory: parse_staff_directory(env["STAFF_DIRECTORY_JSON"]),
    grants: new GoogleTokenGrantStore(create_tenant_secret_cipher(ring), {
      sink: audit,
      metrics,
      // Without a revoker the store refuses to revoke, which would leave a
      // suspected leak with no way to un-mint the credential at the provider.
      revoke_upstream: google_grant_revoker(),
    }),
    kind: "in_memory",
  };
}

/**
 * Build the durable, multi-instance stores.
 *
 * Fails loudly rather than degrading: a missing `DATABASE_URL` here must stop the
 * process, because silently returning the in-memory stores would reintroduce the
 * exact per-instance behaviour this adapter exists to remove, and it would do so
 * on a deployment that believes it is shared.
 *
 * @param context - Configuration, key ring, audit sink, and metrics.
 * @returns Durable stores over one SQL client.
 * @throws OAuthFlowError when no connection string is configured.
 */
export function postgres_stores(context: StaffAuthStoreContext): StaffAuthStores {
  const { audit, metrics, ring, env } = context;
  if (typeof env["DATABASE_URL"] !== "string" || env["DATABASE_URL"].trim() === "") {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  const sql_client = new PgSqlClient(load_pg_config(env));
  return {
    state_store: new PostgresOAuthStateStore(sql_client),
    session_store: new PostgresStaffSessionStore(sql_client),
    directory: parse_staff_directory(env["STAFF_DIRECTORY_JSON"]),
    grants: new GoogleTokenGrantStore(create_tenant_secret_cipher(ring), {
      sink: audit,
      metrics,
      revoke_upstream: google_grant_revoker(),
      repository: new PostgresGoogleTokenGrantRepository(sql_client),
    }),
    kind: "shared",
  };
}

/**
 * Enforce the topology the composed stores can actually support.
 *
 * This is the extension of the original startup guard, not a second mechanism. The
 * original refused any non-loopback origin because the stores below it were
 * single-process; that reasoning is unchanged for `in_memory`, and is lifted only
 * when the factory really produced durable adapters.
 *
 * @param config - Validated staff authentication configuration.
 * @param stores - The composed stores.
 * @throws OAuthFlowError when process-local stores would serve a public origin.
 */
export function assert_store_topology(config: StaffAuthConfig, stores: StaffAuthStores): void {
  if (stores.kind === "shared") return;
  if (!is_loopback_public_base_url(config)) throw new OAuthFlowError("oauth_configuration_invalid");
}
