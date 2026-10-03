/**
 * Abuse coverage for the OAuth `state` control.
 *
 * The state parameter is the CSRF control for every authorization-code flow in
 * the product, so each way it can be defeated is asserted separately: absent,
 * malformed, forged, expired, replayed, moved between flows, and moved between
 * tenants.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_OAUTH_STATE_TTL_SECONDS,
  InMemoryOAuthStateStore,
  MAX_OAUTH_STATE_TTL_SECONDS,
} from "../src/enterprise/oauth/oauth_state.js";
import { complete_authorization } from "../src/enterprise/oauth/oauth_flow.js";
import { OAuthFlowError } from "../src/enterprise/oauth/oauth_error.js";

const START_MS = Date.parse("2026-09-25T00:00:00.000Z");
const VERIFIER = "a".repeat(43);
const NONCE = "n".repeat(32);

function store_at(now_ms: () => number, ttl_seconds = 300): InMemoryOAuthStateStore {
  return new InMemoryOAuthStateStore({ clock: now_ms, ttl_seconds });
}

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

/** An exchanger that must never be reached by a binding refusal. */
const UNREACHABLE_EXCHANGER = {
  exchange: () => {
    throw new Error("code-exchanger-reached-after-binding-refusal");
  },
};

/**
 * Drive a callback at `complete_authorization` for one state value.
 *
 * @param store - Store holding the issued state.
 * @param state - Raw state value the callback presents.
 * @param expected_purpose - Purpose the callback route expects.
 * @param expected_idp - Provider the callback route expects.
 * @returns The completed authorization, which a refusal never resolves to.
 */
function finish(
  store: InMemoryOAuthStateStore,
  state: string,
  expected_purpose: "staff_login" | "calendar_consent",
  expected_idp: "supabase" | "google" = "supabase",
): Promise<unknown> {
  return complete_authorization(
    store,
    UNREACHABLE_EXCHANGER,
    {
      issuer_url: "https://idp.test.invalid/auth/v1",
      jwks_url: "https://idp.test.invalid/auth/v1/jwks",
      staff_audience: "fake-client-id",
    },
    {
      idp: expected_idp,
      expected_purpose,
      client_id: "fake-client-id",
      client_secret: "fake-client-secret",
      redirect_uri: "https://staff.example.com/auth/callback",
      params: { code: "unused-authorization-code", state },
      allowed_return_paths: ["/actions"],
    },
  );
}

describe("OAuth state abuse resistance", () => {
  it("persists only a hash and returns the raw state exactly once", async () => {
    const store = store_at(() => START_MS);
    const issued = await store.issue(issue_input());
    expect(issued.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(store)).not.toContain(issued.state);
    const consumed = await store.consume(issued.state);
    expect(consumed.state_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(consumed.state_hash).not.toBe(issued.state);
  });

  it("issues a distinct state for every request", async () => {
    const store = store_at(() => START_MS);
    const first = await store.issue(issue_input());
    const second = await store.issue(issue_input());
    expect(first.state).not.toBe(second.state);
  });

  it("rejects a missing state instead of treating it as unknown", async () => {
    const store = store_at(() => START_MS);
    await expect(store.consume(undefined)).rejects.toMatchObject({ code: "oauth_state_missing" });
    await expect(store.consume("")).rejects.toMatchObject({ code: "oauth_state_missing" });
  });

  it("rejects a malformed state without a store lookup", async () => {
    const store = store_at(() => START_MS);
    await expect(store.consume("short")).rejects.toMatchObject({ code: "oauth_state_malformed" });
    await expect(store.consume("A".repeat(42))).rejects.toMatchObject({ code: "oauth_state_malformed" });
    await expect(store.consume("A".repeat(43) + "=")).rejects.toMatchObject({ code: "oauth_state_malformed" });
  });

  it("rejects a state this process never issued", async () => {
    const store = store_at(() => START_MS);
    const forged = Buffer.alloc(32, 7).toString("base64url");
    await expect(store.consume(forged)).rejects.toMatchObject({ code: "oauth_state_unknown" });
  });

  it("rejects a state from a different store instance", async () => {
    const first = store_at(() => START_MS);
    const second = store_at(() => START_MS);
    const issued = await first.issue(issue_input());
    await expect(second.consume(issued.state)).rejects.toMatchObject({ code: "oauth_state_unknown" });
  });

  it("rejects a replayed state on the second attempt", async () => {
    const store = store_at(() => START_MS);
    const issued = await store.issue(issue_input());
    await store.consume(issued.state);
    await expect(store.consume(issued.state)).rejects.toMatchObject({ code: "oauth_state_replayed" });
  });

  it("rejects a state once its TTL has passed", async () => {
    let now_ms = START_MS;
    const store = store_at(() => now_ms);
    const issued = await store.issue(issue_input({ }));
    now_ms = START_MS + (DEFAULT_OAUTH_STATE_TTL_SECONDS + 1) * 1_000;
    await expect(store.consume(issued.state)).rejects.toMatchObject({ code: "oauth_state_expired" });
  });

  it("binds the state to its purpose, idp, and tenant", async () => {
    const store = store_at(() => START_MS);
    const login = await store.issue(issue_input({ purpose: "staff_login", tenant_id: null }));
    const consent = await store.issue(issue_input({ purpose: "calendar_consent", tenant_id: "1001" }));
    const login_record = await store.consume(login.state);
    const consent_record = await store.consume(consent.state);
    expect(login_record.purpose).toBe("staff_login");
    expect(login_record.tenant_id).toBeNull();
    expect(consent_record.purpose).toBe("calendar_consent");
    expect(consent_record.tenant_id).toBe("1001");
  });

  it("refuses a login state spent on the consent callback and the reverse", async () => {
    // A login callback and a consent callback are different routes with
    // different tenant consequences, so a state issued for one must not be
    // redeemable at the other. The exchanger is never reached: the refusal has
    // to happen before any credential is exchanged.
    const store = store_at(() => START_MS);
    const login = await store.issue(issue_input({ purpose: "staff_login", tenant_id: null }));
    await expect(finish(store, login.state, "calendar_consent"))
      .rejects.toMatchObject({ code: "oauth_state_unknown" });

    const second = store_at(() => START_MS);
    const consent = await second.issue(issue_input({ purpose: "calendar_consent", tenant_id: "1001" }));
    await expect(finish(second, consent.state, "staff_login"))
      .rejects.toMatchObject({ code: "oauth_state_unknown" });
  });

  it("refuses a state issued for another provider", async () => {
    const store = store_at(() => START_MS);
    const issued = await store.issue(issue_input({ idp: "google" }));
    const attempt = finish(store, issued.state, "staff_login", "supabase");
    await expect(attempt).rejects.toMatchObject({ code: "oauth_idp_unknown" });
  });

  it("refuses a tenant id that is not a positive integer", async () => {
    const store = store_at(() => START_MS);
    for (const tenant_id of ["0", "-1", "10a", " 1001", "1001 ", ""]) {
      await expect(store.issue(issue_input({ tenant_id }))).rejects.toBeInstanceOf(OAuthFlowError);
    }
  });

  it("refuses an unknown provider or purpose", async () => {
    const store = store_at(() => START_MS);
    await expect(store.issue(issue_input({ idp: "okta" }))).rejects.toMatchObject({ code: "oauth_idp_unknown" });
    await expect(store.issue(issue_input({ purpose: "customer_login" }))).rejects.toMatchObject({
      code: "oauth_configuration_invalid",
    });
  });

  it("refuses a return path that is absolute or traverses", async () => {
    const store = store_at(() => START_MS);
    for (const return_path of ["https://evil.example", "//evil.example", "/actions/../admin", "/actions/"]) {
      await expect(store.issue(issue_input({ return_path }))).rejects.toMatchObject({
        code: "oauth_return_path_invalid",
      });
    }
  });

  it("refuses a weak verifier or a short nonce", async () => {
    const store = store_at(() => START_MS);
    await expect(store.issue(issue_input({ code_verifier: "short" }))).rejects.toMatchObject({ code: "oauth_pkce_invalid" });
    await expect(store.issue(issue_input({ nonce: "short" }))).rejects.toMatchObject({
      code: "oauth_configuration_invalid",
    });
  });

  it("bounds the TTL and refuses a value outside the allowed window", () => {
    expect(() => store_at(() => START_MS, 10)).toThrow(OAuthFlowError);
    expect(() => store_at(() => START_MS, MAX_OAUTH_STATE_TTL_SECONDS + 1)).toThrow(OAuthFlowError);
    expect(() => store_at(() => START_MS, MAX_OAUTH_STATE_TTL_SECONDS)).not.toThrow();
  });

  it("sweeps a consumed record only after its replay grace window", async () => {
    let now_ms = START_MS;
    const store = store_at(() => now_ms);
    const issued = await store.issue(issue_input());
    await store.consume(issued.state);
    now_ms = START_MS + DEFAULT_OAUTH_STATE_TTL_SECONDS * 1_000 + 61_000;
    await expect(store.consume(issued.state)).rejects.toMatchObject({ code: "oauth_state_unknown" });
  });
});
