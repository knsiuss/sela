/**
 * Admission control on the real login route, plus the source-key derivation.
 *
 * The flood probe here drives the actual `GET` exported from the login route, not
 * the limiter in isolation, because the defect was never in the limiter — it was
 * that nothing stood between an anonymous request and the state store. Measured
 * before this change, the same 10,000 anonymous requests produced 10,000 issued
 * states and then a permanent `503 oauth_state_capacity` for every user.
 *
 * What the probe asserts is the two halves of "degrades instead of locking out":
 * the flood is throttled with a retryable status rather than being allowed to grow
 * the table or to lock it, and a different source can still complete a login while
 * the flood is in progress.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { reset_runtime, runtime, start_login } from "../src/app/auth/runtime";
import { source_bucket_key } from "../src/app/auth/client_address";
import { OAuthFlowError } from "appointment-agent/dist/src/enterprise/oauth/index.js";
import type { StaffAuthRuntime } from "../src/app/auth/runtime";

const KEY_BASE64 = randomBytes(32).toString("base64");

/** Requests the probe issues; large enough to exhaust any plausible burst. */
const FLOOD_REQUESTS = 10_000;

/** A fully configured loopback environment: the only shape `runtime` accepts. */
const LOOPBACK_ENV: Record<string, string> = {
  STAFF_AUTH_REDIRECT_ALLOW_LIST: "http://127.0.0.1:3000/auth/callback",
  STAFF_AUTH_LOGIN_REDIRECT_URI: "http://127.0.0.1:3000/auth/callback",
  STAFF_AUTH_CALENDAR_REDIRECT_URI: "http://127.0.0.1:3000/auth/callback",
  STAFF_AUTH_PUBLIC_BASE_URL: "http://127.0.0.1:3000",
  STAFF_AUTH_ALLOW_INSECURE_LOOPBACK: "true",
  // One trusted reverse proxy, so the probe can model two distinct clients. Without
  // this every caller shares one bucket, which is the correct default for a
  // directly-exposed instance and useless for measuring per-source isolation.
  STAFF_AUTH_TRUSTED_PROXY_HOPS: "1",
  STAFF_DIRECTORY_JSON: JSON.stringify({
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
  }),
  WHATSAPP_RECIPIENT_ENCRYPTION_KEYS_JSON: JSON.stringify({ active_key_id: "k1", keys: { k1: KEY_BASE64 } }),
  SUPABASE_AUTH_ISSUER_URL: "https://idp.test.invalid/auth/v1",
  SUPABASE_AUTH_JWKS_URL: "https://idp.test.invalid/auth/v1/jwks",
  SUPABASE_AUTH_STAFF_AUDIENCE: "supabase-client-id",
  SUPABASE_AUTH_OAUTH_CLIENT_ID: "supabase-client-id",
  SUPABASE_AUTH_OAUTH_CLIENT_SECRET: "supabase-client-secret",
};

afterEach(() => {
  reset_runtime();
  vi.restoreAllMocks();
});

/** Install the loopback environment for the duration of one test. */
async function with_loopback_env<T>(run: () => Promise<T>): Promise<T> {
  const saved = { ...process.env };
  process.env = { ...process.env, ...LOOPBACK_ENV };
  reset_runtime();
  try {
    return await run();
  } finally {
    process.env = saved;
    reset_runtime();
  }
}

/** A request to the login route as one source, optionally behind a proxy. */
function login_request(source_address?: string): Request {
  const headers = new Headers();
  if (source_address !== undefined) headers.set("x-forwarded-for", source_address);
  return new Request("http://127.0.0.1:3000/auth/login?idp=supabase&return_path=/actions", { headers });
}

describe("the admission key is a bounded, non-identifying digest", () => {
  it("shares one bucket when no proxy is trusted", () => {
    // Trusting `X-Forwarded-For` with nothing in front to set it would hand a
    // caller a fresh bucket per request and disable the limiter entirely.
    expect(source_bucket_key(login_request("203.0.113.9"), 0)).toBe("direct");
    expect(source_bucket_key(login_request(), 0)).toBe("direct");
  });

  it("separates sources only when the deployment declares trusted proxies", () => {
    const first = source_bucket_key(login_request("203.0.113.9"), 1);
    const second = source_bucket_key(login_request("203.0.113.10"), 1);
    expect(first).not.toBe(second);
    expect(source_bucket_key(login_request("203.0.113.9"), 1)).toBe(first);
    expect(first.startsWith("hop:")).toBe(true);
    // The bucket lives in a long-lived map, so retaining a raw address there would
    // be retaining client PII for no benefit.
    expect(first).not.toContain("203.0.113.9");
  });

  it("reads the address the nearest trusted proxy appended, not the leftmost", () => {
    // A caller can prepend anything to the left; only the right-hand entries are
    // written by the trusted hops.
    const spoofed = source_bucket_key(login_request("198.51.100.1, 203.0.113.9"), 1);
    const honest = source_bucket_key(login_request("203.0.113.9"), 1);
    expect(spoofed).toBe(honest);
    expect(source_bucket_key(login_request("198.51.100.1, 203.0.113.9"), 2)).not.toBe(honest);
  });

  it("falls back to the shared bucket for anything that is not an address", () => {
    for (const header of ["", "not-an-ip", "203.0.113.9:8080", "x".repeat(200), "203.0.113.9, ", "<script>"]) {
      expect(source_bucket_key(login_request(header), 1), header).toBe("direct");
    }
  });
});

describe("the login entry point throttles without locking anyone out", () => {
  it("refuses a throttled source and records it for alerting", async () => {
    await with_loopback_env(async () => {
      const parts = runtime();
      const burst = parts.config.admission.burst;
      for (let index = 0; index < burst; index += 1) {
        await expect(start_login(parts, "supabase", "/actions", "hop:flood")).resolves.toMatchObject({ url: expect.any(String) });
      }
      await expect(start_login(parts, "supabase", "/actions", "hop:flood"))
        .rejects.toMatchObject({ code: "oauth_source_rate_limited" });
      // A throttle nobody can see is a throttle nobody investigates.
      expect(parts.audit.records).toContainEqual(expect.objectContaining({
        event: "authorize_request",
        outcome: "not_allowed",
      }));
      expect(parts.metrics.counter_value("oauth_flow_total", {
        event: "authorize_request",
        outcome: "not_allowed",
      })).toBeGreaterThan(0);
      // Another source is unaffected, which is the difference between degraded and
      // locked out.
      await expect(start_login(parts, "supabase", "/actions", "hop:operator")).resolves.toBeDefined();
    });
  });

  it("refuses a hop count it cannot trust at startup", () => {
    for (const value of ["-1", "9", "1.5", "two"]) {
      expect(() => runtime({ ...LOOPBACK_ENV, STAFF_AUTH_TRUSTED_PROXY_HOPS: value }), value).toThrow(OAuthFlowError);
    }
    expect(() => runtime({ ...LOOPBACK_ENV, STAFF_AUTH_TRUSTED_PROXY_HOPS: "1" })).not.toThrow();
  });
});

describe("flood probe through the real route handler", () => {
  it("throttles 10,000 anonymous logins, keeps the table bounded, and still serves a real user", async () => {
    const measurement = await with_loopback_env(async () => {
      const { GET } = await import("../src/app/auth/login/route");
      const parts: StaffAuthRuntime = runtime();
      const store = parts.stores.state_store as unknown as {
        retained_count(): number;
        in_flight_count(): number;
        evicted_count(): number;
      };
      const before = process.memoryUsage().heapUsed;
      const started = process.hrtime.bigint();
      const counts = new Map<number, number>();
      for (let index = 0; index < FLOOD_REQUESTS; index += 1) {
        const response = await GET(login_request("203.0.113.9"));
        counts.set(response.status, (counts.get(response.status) ?? 0) + 1);
      }
      const elapsed_ms = Number(process.hrtime.bigint() - started) / 1_000_000;
      const peak = {
        retained: store.retained_count(),
        in_flight: store.in_flight_count(),
        evicted: store.evicted_count(),
        heap_delta_mb: (process.memoryUsage().heapUsed - before) / (1024 * 1024),
      };
      // A legitimate operator on a different connection, mid-flood.
      const operator = await GET(login_request("203.0.113.77"));
      return { counts, elapsed_ms, peak, operator_status: operator.status, parts };
    });
    const statuses = Object.fromEntries([...measurement.counts].sort(([a], [b]) => a - b));
    // eslint-disable-next-line no-console -- probe evidence printed on purpose
    console.log(
      `[flood-probe] requests=${FLOOD_REQUESTS} elapsed_ms=${measurement.elapsed_ms.toFixed(0)} statuses=${JSON.stringify(statuses)}`
      + ` retained=${measurement.peak.retained} in_flight=${measurement.peak.in_flight}`
      + ` evicted=${measurement.peak.evicted} heap_delta_mb=${measurement.peak.heap_delta_mb.toFixed(1)}`
      + ` operator_status=${measurement.operator_status}`,
    );

    // The flood is throttled with a retryable status, not served and not turned
    // into an outage for everybody.
    expect(measurement.counts.get(302) ?? 0).toBeGreaterThan(0);
    expect(measurement.counts.get(429) ?? 0).toBeGreaterThan(0);
    expect(measurement.counts.get(503) ?? 0).toBe(0);
    // A bucket refills continuously, so the flood may legitimately spend a few
    // tokens beyond the initial burst across the probe's elapsed time — but nowhere
    // near the 10,000 the pre-fix surface served.
    const refill_allowance = Math.ceil((measurement.elapsed_ms / 1_000) * measurement.parts.config.admission.refill_per_second);
    expect(measurement.counts.get(302) ?? 0).toBeLessThanOrEqual(
      measurement.parts.config.admission.burst + refill_allowance + 1,
    );
    // The table never approaches its bound, so nothing was refused for capacity.
    expect(measurement.peak.retained).toBeLessThanOrEqual(200);
    expect(measurement.peak.evicted).toBe(0);
    // And a real operator is still able to sign in while the flood is running.
    expect(measurement.operator_status).toBe(302);
    // The throttle must be visible to alerting, not silent.
    expect(measurement.parts.audit.records.filter((record) => record.outcome === "not_allowed").length)
      .toBeGreaterThan(FLOOD_REQUESTS / 2);
  });
});
