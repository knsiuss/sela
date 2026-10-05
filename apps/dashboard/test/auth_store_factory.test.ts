/**
 * The store-factory seam in the staff-auth composition root.
 *
 * Before this seam existed, `runtime()` constructed process-local stores
 * unconditionally and refused to start anywhere but loopback. That refusal was the
 * right call for a single-process store and the wrong constraint for a deployment
 * that could supply durable adapters, so the choice of topology became explicit
 * here — and the property that matters is that it is *honest*: a factory that
 * claims `shared` has to have produced shared adapters, and one that cannot has to
 * stop the process rather than quietly fall back to memory.
 *
 * Nothing in this file reaches a database. The Postgres factory is exercised only
 * for the refusal it must perform when no connection string is configured, which is
 * the part that can be proven without one. UNPROVEN against a live database: every
 * other property of that factory.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { reset_runtime, runtime } from "../src/app/auth/runtime";
import {
  assert_store_topology,
  in_memory_stores,
  postgres_stores,
  type StaffAuthStoreContext,
} from "../src/app/auth/store_factory";
import { InMemoryOAuthAuditSink } from "appointment-agent/dist/src/enterprise/oauth/index.js";
import { MetricsRegistry } from "appointment-agent/dist/src/observability/metrics.js";
import { parse_recipient_key_ring } from "appointment-agent/dist/src/security/recipient_key_ring.js";
import { parse_staff_auth_config, OAuthFlowError } from "appointment-agent/dist/src/enterprise/oauth/index.js";

const KEY_RING_JSON = JSON.stringify({ active_key_id: "k1", keys: { k1: randomBytes(32).toString("base64") } });

const DIRECTORY_JSON = JSON.stringify({
  entries: [{
    issuer: "https://idp.test.invalid",
    subject_id: "staff-subject-1",
    org_id: "acme",
    tenant_id: "1001",
    roles: ["owner"],
    status: "active",
    invited_at_iso: "2026-01-01T00:00:00.000Z",
    updated_at_iso: "2026-01-02T00:00:00.000Z",
  }],
});

/** Provider and directory settings every composed runtime needs. */
const BASE_ENV: Record<string, string> = {
  STAFF_DIRECTORY_JSON: DIRECTORY_JSON,
  WHATSAPP_RECIPIENT_ENCRYPTION_KEYS_JSON: KEY_RING_JSON,
  SUPABASE_AUTH_ISSUER_URL: "https://idp.test.invalid/auth/v1",
  SUPABASE_AUTH_JWKS_URL: "https://idp.test.invalid/auth/v1/jwks",
  SUPABASE_AUTH_STAFF_AUDIENCE: "supabase-client-id",
  SUPABASE_AUTH_OAUTH_CLIENT_ID: "supabase-client-id",
  SUPABASE_AUTH_OAUTH_CLIENT_SECRET: "supabase-client-secret",
};

/** A published https origin, which is what the loopback restriction exists to fence. */
const PUBLIC_ENV: Record<string, string> = {
  ...BASE_ENV,
  STAFF_AUTH_REDIRECT_ALLOW_LIST: "https://staff.example.com/auth/callback",
  STAFF_AUTH_LOGIN_REDIRECT_URI: "https://staff.example.com/auth/callback",
  STAFF_AUTH_CALENDAR_REDIRECT_URI: "https://staff.example.com/auth/callback",
  STAFF_AUTH_PUBLIC_BASE_URL: "https://staff.example.com",
  STAFF_AUTH_ALLOW_INSECURE_LOOPBACK: "false",
};

/** The loopback origin this repository develops and tests against. */
const LOOPBACK_ENV: Record<string, string> = {
  ...BASE_ENV,
  STAFF_AUTH_REDIRECT_ALLOW_LIST: "http://127.0.0.1:3000/auth/callback",
  STAFF_AUTH_LOGIN_REDIRECT_URI: "http://127.0.0.1:3000/auth/callback",
  STAFF_AUTH_CALENDAR_REDIRECT_URI: "http://127.0.0.1:3000/auth/callback",
  STAFF_AUTH_PUBLIC_BASE_URL: "http://127.0.0.1:3000",
  STAFF_AUTH_ALLOW_INSECURE_LOOPBACK: "true",
};

afterEach(() => {
  reset_runtime();
  vi.restoreAllMocks();
});

/** Build the context a factory receives, without composing a runtime for it. */
function context_for(env: Record<string, string | undefined> = {}): StaffAuthStoreContext {
  return {
    config: parse_staff_auth_config(LOOPBACK_ENV),
    env,
    ring: parse_recipient_key_ring({ WHATSAPP_RECIPIENT_ENCRYPTION_KEYS_JSON: KEY_RING_JSON }),
    audit: new InMemoryOAuthAuditSink(),
    metrics: new MetricsRegistry(),
  };
}

/** A factory that reports a topology without building real adapters. */
function unused(): void {}
describe("the composition root takes its topology from a factory", () => {
  it("uses the injected factory and lifts the loopback restriction for it", () => {
    const parts = runtime(PUBLIC_ENV, {
      store_factory: () => ({
        state_store: {
          issue: async () => ({ state: "stub", expires_at_ms: 0 }),
          consume: async () => {
            throw new OAuthFlowError("oauth_state_unknown");
          },
        },
        session_store: {} as never,
        directory: {} as never,
        grants: {} as never,
        kind: "shared" as const,
      }),
    });
    // Proof the seam is a seam: a deployment supplying durable adapters is no
    // longer refused for publishing beyond loopback.
    expect(parts.config.public_base_url).toBe("https://staff.example.com");
    expect(parts.stores.kind).toBe("shared");
  });

  it("still refuses a public origin when no factory is supplied", () => {
    expect(() => runtime(PUBLIC_ENV)).toThrow(OAuthFlowError);
    expect(() => runtime(LOOPBACK_ENV)).not.toThrow();
  });
});

describe("the topology guard extends the loopback restriction rather than adding one", () => {
  it("permits process-local stores on loopback and refuses them on a public origin", () => {
    const loopback = context_for();
    expect(() => assert_store_topology(loopback.config, in_memory_stores(loopback))).not.toThrow();
    const published = { ...loopback.config, public_base_url: "https://staff.example.com" };
    expect(() => assert_store_topology(published, in_memory_stores({ ...loopback, config: published })))
      .toThrow(OAuthFlowError);
  });

  it("permits shared stores on a public origin", () => {
    const context = context_for();
    const published = { ...context.config, public_base_url: "https://staff.example.com" };
    const stores = { ...in_memory_stores(context), kind: "shared" as const };
    // The guard reads the topology the factory reported, not the class it built, so
    // the decision is stated once and read from one place.
    expect(() => assert_store_topology(published, stores)).not.toThrow();
  });
});

describe("the durable factory refuses rather than degrading to memory", () => {
  it("stops the process when no connection string is configured", () => {
    // Falling back to the in-memory stores here would reintroduce exactly the
    // per-instance behaviour the adapter exists to remove, and it would do so on a
    // deployment that believes it is shared.
    expect(() => postgres_stores(context_for({}))).toThrow(OAuthFlowError);
    expect(() => postgres_stores(context_for({ DATABASE_URL: "   " }))).toThrow(OAuthFlowError);
  });

  it("never reaches the network while refusing", () => {
    const fetch_spy = vi.spyOn(globalThis, "fetch");
    expect(() => postgres_stores(context_for({}))).toThrow(OAuthFlowError);
    expect(fetch_spy).not.toHaveBeenCalled();
  });

  it("names the refusal as a configuration error rather than a tenant or session fault", () => {
    try {
      postgres_stores(context_for({}));
      expect.unreachable("expected-postgres-stores-to-refuse");
    } catch (error) {
      expect(error).toBeInstanceOf(OAuthFlowError);
      expect((error as OAuthFlowError).code).toBe("oauth_configuration_invalid");
      // The message must not carry the connection string or a driver message.
      expect((error as Error).message).toBe("oauth-flow-failed: oauth_configuration_invalid");
    }
  });
});
