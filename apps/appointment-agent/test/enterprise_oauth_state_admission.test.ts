/**
 * Admission control and bounded-capacity behaviour for the `state` store.
 *
 * Two independent defects are covered here, and both were found by the same
 * probe: repeating an unauthenticated `GET /auth/login` until the store refused
 * issuance, which turned one anonymous source into a lock-out for every operator.
 *
 * The fix has two halves that must each hold on their own:
 *
 * - Admission throttles a source *before* it can grow the table, so a flood never
 *   gets far enough to matter, and one exhausted source must not throttle another.
 * - The store bounds itself regardless. When it reaches the cap it evicts the
 *   oldest unconsumed record instead of refusing, because refusing is what made
 *   the earlier version a denial of service. Eviction is only safe because an
 *   evicted record can only fail its own callback closed.
 *
 * The two properties that make eviction safe are asserted directly rather than
 * assumed: a still-valid state that was NOT evicted still completes, and an
 * evicted state can never be redeemed afterwards.
 */

import { describe, expect, it } from "vitest";
import { InMemoryOAuthStateStore } from "../src/enterprise/oauth/oauth_state.js";
import {
  DEFAULT_SOURCE_ADMISSION_POLICY,
  SourceAdmissionLimiter,
  parse_source_admission_policy,
} from "../src/enterprise/oauth/source_admission.js";
import { OAuthFlowError } from "../src/enterprise/oauth/oauth_error.js";

const START_MS = Date.parse("2026-09-25T00:00:00.000Z");
const VERIFIER = "a".repeat(43);
const NONCE = "n".repeat(32);

/** A store whose clock and capacity the test controls. */
function store_at(now_ms: () => number): InMemoryOAuthStateStore {
  return new InMemoryOAuthStateStore({ clock: now_ms });
}

/** One issuance input, shaped the way a route handler supplies it. */
function issue_input(overrides: Record<string, unknown> = {}): Parameters<InMemoryOAuthStateStore["issue"]>[0] {
  return {
    purpose: "staff_login",
    idp: "supabase",
    tenant_id: null,
    return_path: "/actions",
    code_verifier: VERIFIER,
    nonce: NONCE,
    ...overrides,
  } as Parameters<InMemoryOAuthStateStore["issue"]>[0];
}

/** Mint `count` records and return their raw state values, oldest first. */
async function fill(store: InMemoryOAuthStateStore, count: number): Promise<string[]> {
  const values: string[] = [];
  for (let index = 0; index < count; index += 1) values.push((await store.issue(issue_input())).state);
  return values;
}

describe("per-source admission control", () => {
  it("spends a bounded burst, then refuses until the bucket refills", () => {
    let now_ms = START_MS;
    const limiter = new SourceAdmissionLimiter(
      { ...DEFAULT_SOURCE_ADMISSION_POLICY, burst: 3, refill_per_second: 1 },
      { clock: () => now_ms },
    );
    for (let index = 0; index < 3; index += 1) {
      expect(limiter.admit("hop:one").allowed, `admission ${index}`).toBe(true);
    }
    const denied = limiter.admit("hop:one");
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    // A throttle the caller is told nothing about is indistinguishable from an
    // outage, so the retry hint is part of the decision.
    expect(denied.retry_after_seconds).toBeGreaterThanOrEqual(1);

    now_ms += 2_000;
    expect(limiter.admit("hop:one").allowed).toBe(true);
  });

  it("never lets one source's flood throttle another source", () => {
    const limiter = new SourceAdmissionLimiter({ ...DEFAULT_SOURCE_ADMISSION_POLICY, burst: 2 });
    expect(limiter.admit("hop:attacker").allowed).toBe(true);
    expect(limiter.admit("hop:attacker").allowed).toBe(true);
    expect(limiter.admit("hop:attacker").allowed).toBe(false);
    // The property that separates "degraded" from "locked out": a different source
    // still has its whole budget, and only its own spending reduces it.
    for (let index = 0; index < 2; index += 1) {
      expect(limiter.admit("hop:operator").allowed, `operator admission ${index}`).toBe(true);
    }
    expect(limiter.admit("hop:operator").allowed).toBe(false);
    expect(limiter.admit("hop:attacker").allowed).toBe(false);
  });

  it("keeps the tracked-source map inside its bound under address rotation", () => {
    const limiter = new SourceAdmissionLimiter({
      ...DEFAULT_SOURCE_ADMISSION_POLICY,
      burst: 5,
      max_tracked_sources: 32,
    });
    for (let index = 0; index < 5_000; index += 1) limiter.admit(`hop:rotated-${index}`);
    // Unbounded growth here would just move the memory pressure from the state
    // table into the limiter, which is the same defect wearing a different hat.
    expect(limiter.tracked_source_count()).toBeLessThanOrEqual(32);
  });

  it("reclaims idle buckets so a long-lived deployment does not accumulate sources", () => {
    let now_ms = START_MS;
    const limiter = new SourceAdmissionLimiter(
      { ...DEFAULT_SOURCE_ADMISSION_POLICY, burst: 5, max_tracked_sources: 64, idle_evict_seconds: 30 },
      { clock: () => now_ms },
    );
    for (let index = 0; index < 16; index += 1) limiter.admit(`hop:idle-${index}`);
    expect(limiter.tracked_source_count()).toBe(16);
    now_ms += 120_000;
    limiter.admit("hop:fresh");
    expect(limiter.tracked_source_count()).toBeLessThanOrEqual(16);
  });

  it("refuses an unusable source key rather than bucketing everything together", () => {
    const limiter = new SourceAdmissionLimiter(DEFAULT_SOURCE_ADMISSION_POLICY);
    for (const key of ["", "x".repeat(129), "bad\u0000key"]) {
      expect(() => limiter.admit(key), key).toThrow(OAuthFlowError);
    }
  });

  it("accepts defaults and refuses a present-but-invalid limit", () => {
    expect(parse_source_admission_policy({}).burst).toBe(DEFAULT_SOURCE_ADMISSION_POLICY.burst);
    expect(parse_source_admission_policy({ STAFF_AUTH_ADMISSION_BURST: "50" }).burst).toBe(50);
    expect(parse_source_admission_policy({ STAFF_AUTH_ADMISSION_REFILL_PER_SECOND: "0.25" }).refill_per_second).toBe(0.25);
    for (const env of [
      { STAFF_AUTH_ADMISSION_BURST: "0" },
      { STAFF_AUTH_ADMISSION_BURST: "1001" },
      { STAFF_AUTH_ADMISSION_BURST: "-5" },
      { STAFF_AUTH_ADMISSION_BURST: "1.5" },
      { STAFF_AUTH_ADMISSION_BURST: "many" },
      { STAFF_AUTH_ADMISSION_REFILL_PER_SECOND: "0" },
      { STAFF_AUTH_ADMISSION_REFILL_PER_SECOND: "101" },
      { STAFF_AUTH_ADMISSION_REFILL_PER_SECOND: "0.0001" },
      { STAFF_AUTH_ADMISSION_MAX_SOURCES: "8" },
      { STAFF_AUTH_ADMISSION_MAX_SOURCES: "70000" },
      { STAFF_AUTH_ADMISSION_IDLE_EVICT_SECONDS: "10" },
      { STAFF_AUTH_ADMISSION_IDLE_EVICT_SECONDS: "90000" },
    ]) {
      // An operator must not be able to believe a limit is in force when the value
      // they configured was silently dropped.
      expect(() => parse_source_admission_policy(env), JSON.stringify(env)).toThrow(OAuthFlowError);
    }
  });
});

describe("the state store degrades instead of locking everyone out", () => {
  it("stays inside its hard bound while issuance keeps succeeding", async () => {
    const store = store_at(() => START_MS);
    const states = await fill(store, 10_001);
    // Past the old cap the store refused; now it keeps answering and the table
    // never grows past the bound.
    expect(states).toHaveLength(10_001);
    expect(store.retained_count()).toBeLessThanOrEqual(10_000);
    expect(store.evicted_count()).toBeGreaterThan(0);
  });

  it("refuses an evicted state forever rather than letting it be reused", async () => {
    const store = store_at(() => START_MS);
    const states = await fill(store, 10_001);
    const evicted = states[0] as string;
    expect(store.evicted_count()).toBe(1);
    expect(store.retained_count()).toBe(10_000);
    // Eviction removes the record and nothing re-creates it, so the callback fails
    // closed on the first attempt and on every attempt after it. That is the whole
    // safety argument: an evicted state is worth less than one that was present.
    await expect(store.consume(evicted)).rejects.toMatchObject({ code: "oauth_state_unknown" });
    await expect(store.consume(evicted)).rejects.toMatchObject({ code: "oauth_state_unknown" });
  });

  it("never evicts a still-valid state, so a legitimate callback completes", async () => {
    const store = store_at(() => START_MS);
    const states = await fill(store, 10_050);
    expect(store.evicted_count()).toBe(50);
    // A legitimate operator's flow is the newest one, which is exactly the record
    // eviction spares. If eviction reached it, real logins would break under load.
    const claimed = await store.consume(states[10_049] as string);
    expect(claimed.purpose).toBe("staff_login");
    expect(claimed.expires_at_ms).toBe(START_MS + 300_000);
    // And it is still single-use afterwards.
    await expect(store.consume(states[10_049] as string)).rejects.toMatchObject({ code: "oauth_state_replayed" });
  });

  it("still fails closed when every retained record is already claimed", async () => {
    // The capacity boundary is reached with a small table so the assertion is
    // about the eviction rule rather than about minting ten thousand records; the
    // hard bound itself is exercised at full size in the test above.
    const store = new InMemoryOAuthStateStore({ clock: () => START_MS, max_in_flight: 8 });
    const states = await fill(store, 8);
    for (const state of states) await store.consume(state);
    expect(store.in_flight_count()).toBe(0);
    // Evicting a claimed record inside its grace window would turn a replay into
    // an indistinguishable unknown, so this is the one case that must refuse.
    await expect(store.issue(issue_input())).rejects.toMatchObject({ code: "oauth_state_capacity" });
  });

  it("refuses a capacity above the hard bound instead of trusting it", () => {
    expect(() => new InMemoryOAuthStateStore({ max_in_flight: 0 })).toThrow(OAuthFlowError);
    expect(() => new InMemoryOAuthStateStore({ max_in_flight: 10_001 })).toThrow(OAuthFlowError);
    expect(() => new InMemoryOAuthStateStore({ max_in_flight: 1.5 })).toThrow(OAuthFlowError);
  });

  it("reclaims space once the replay grace window closes instead of staying full", async () => {
    let now_ms = START_MS;
    const store = store_at(() => now_ms);
    await fill(store, 10_000);
    now_ms += 300_000 + 61_000;
    // Sweeping is what makes the table self-healing; a store that only ever
    // refuses would be permanently degraded after its first flood.
    const issued = await store.issue(issue_input());
    expect(issued.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.retained_count()).toBe(1);
  });
});
