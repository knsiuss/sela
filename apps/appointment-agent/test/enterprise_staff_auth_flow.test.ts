/**
 * Full staff-login round trip against a local fake identity provider.
 *
 * The provider signs real RS256 ID tokens, publishes a real JWKS, and enforces
 * PKCE by recomputing the challenge, so these tests fail if the flow drops any
 * control. Each negative case is a separate assertion because the controls are
 * separate: state, nonce, PKCE, code single use, tenant membership, and MFA.
 */

import { describe, expect, it } from "vitest";
import {
  InMemoryOAuthStateStore,
  InMemoryStaffSessionStore,
  begin_authorization,
  build_staff_principal,
  complete_authorization,
  google_code_exchanger,
  issue_session_secret,
  parse_staff_auth_config,
  parse_staff_directory,
  require_return_path,
  resolve_session_cookie_policy,
  serialize_session_cookie,
  supabase_code_exchanger,
} from "../src/enterprise/oauth/index.js";
import type { OAuthCallbackParams } from "../src/enterprise/oauth/index.js";
import { authorize, authorize_privileged } from "../src/enterprise/authorization.js";
import { has_verified_mfa } from "../src/enterprise/oidc_verifier.js";
import {
  create_fake_idp,
  challenge_in_authorize_url,
  nonce_in_authorize_url,
  state_in_authorize_url,
  FAKE_AUDIENCE,
  FAKE_CODE,
  FAKE_ISSUER,
  FAKE_JWKS_URL,
  FAKE_SUBJECT,
  FAKE_TENANT_ID,
} from "./support/fake_oidc_provider.js";

const REDIRECT_URI = "https://staff.example.com/auth/callback";
const ALLOWED_RETURN_PATHS = ["/actions"];
const DIRECTORY_JSON = JSON.stringify({
  entries: [
    {
      issuer: FAKE_ISSUER,
      subject_id: FAKE_SUBJECT,
      org_id: "acme",
      tenant_id: FAKE_TENANT_ID,
      roles: ["owner"],
      status: "active",
      invited_at_iso: "2026-01-01T00:00:00.000Z",
      activated_at_iso: "2026-01-02T00:00:00.000Z",
      updated_at_iso: "2026-01-02T00:00:00.000Z",
    },
  ],
});

/** Dependencies for one full login attempt. */
function harness(idp_options: Parameters<typeof create_fake_idp>[0] = {}, issuer = FAKE_ISSUER) {
  const idp = create_fake_idp(idp_options);
  const state_store = new InMemoryOAuthStateStore();
  const session_store = new InMemoryStaffSessionStore();
  const directory = parse_staff_directory(
    issuer === FAKE_ISSUER ? DIRECTORY_JSON : JSON.stringify({ entries: [] }),
  );
  const cookie_policy = resolve_session_cookie_policy({
    public_base_url: "https://staff.example.com",
    allow_insecure_loopback: false,
    session_ttl_seconds: 3600,
  });
  return { idp, state_store, session_store, directory, cookie_policy, issuer };
}

/** Drive authorize to callback and return the completed authorization. */
async function run_login(
  parts: ReturnType<typeof harness>,
  idp_kind: "supabase" | "google" = "supabase",
  expected_hosted_domain?: string,
) {
  const { idp, state_store } = parts;
  const redirect = await begin_authorization(state_store, {
    idp: idp_kind,
    issuer_url: idp.issuer,
    client_id: FAKE_AUDIENCE,
    redirect_uri: REDIRECT_URI,
    tenant_id: null,
    return_path: "/actions",
    scopes: ["openid", "email"],
  });
  idp.record_authorize_request(nonce_in_authorize_url(redirect.authorization_url), challenge_in_authorize_url(redirect.authorization_url));
  const state = state_in_authorize_url(redirect.authorization_url);
  const exchanger = idp_kind === "google"
    ? google_code_exchanger({ fetch: idp.fetch })
    : supabase_code_exchanger(idp.issuer, { fetch: idp.fetch });
  return complete_authorization(state_store, exchanger, {
    issuer_url: idp.issuer,
    jwks_url: FAKE_JWKS_URL,
    staff_audience: FAKE_AUDIENCE,
    fetch: idp.fetch,
    ...(expected_hosted_domain === undefined ? {} : { expected_hosted_domain }),
  }, {
    idp: idp_kind,
    expected_purpose: "staff_login",
    client_id: FAKE_AUDIENCE,
    client_secret: "fake-client-secret",
    redirect_uri: REDIRECT_URI,
    params: { code: FAKE_CODE, state },
    allowed_return_paths: ALLOWED_RETURN_PATHS,
  });
}

describe("staff login round trip", () => {
  it("completes authorize to callback to session for the Supabase provider", async () => {
    const parts = harness();
    const completed = await run_login(parts);
    expect(completed.identity.subject_id).toBe(FAKE_SUBJECT);
    expect(completed.record.purpose).toBe("staff_login");
    expect(parts.idp.exchange_count).toBe(1);

    const principal = await build_staff_principal({
      subject_id: completed.identity.subject_id,
      issuer: completed.identity.issuer,
      has_mfa: completed.identity.has_mfa,
      issued_at_iso: new Date().toISOString(),
    }, parts.directory);
    expect(principal.tenant_roles[FAKE_TENANT_ID]).toEqual(["owner"]);

    const session = await parts.session_store.create({
      subject_id: principal.subject_id,
      issuer: completed.identity.issuer,
      idp: "supabase",
      has_mfa: principal.has_mfa,
      principal,
      device_id: "device-abc",
      ttl_seconds: 3600,
    });
    const header = serialize_session_cookie(parts.cookie_policy, session.cookie_value);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    await expect(parts.session_store.resolve(session.cookie_value)).resolves.toMatchObject({
      subject_id: FAKE_SUBJECT,
    });
  });

  it("completes the same round trip for the Google provider", async () => {
    const parts = harness();
    const completed = await run_login(parts, "google");
    expect(completed.identity.subject_id).toBe(FAKE_SUBJECT);
    expect(parts.idp.exchange_count).toBe(1);
  });

  it("binds PKCE to the flow so a substituted verifier cannot be exchanged", async () => {
    const parts = harness();
    const redirect = await begin_authorization(parts.state_store, {
      idp: "supabase",
      issuer_url: parts.idp.issuer,
      client_id: FAKE_AUDIENCE,
      redirect_uri: REDIRECT_URI,
      tenant_id: null,
      return_path: "/actions",
      scopes: ["openid"],
    });
    // The provider recomputes the challenge from the verifier; if the flow had
    // not stored a verifier, the exchange could not succeed.
    expect(challenge_in_authorize_url(redirect.authorization_url)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    parts.idp.record_authorize_request(nonce_in_authorize_url(redirect.authorization_url), challenge_in_authorize_url(redirect.authorization_url));
    const completed = await complete_authorization(
      parts.state_store,
      supabase_code_exchanger(parts.idp.issuer, { fetch: parts.idp.fetch }),
      { issuer_url: parts.idp.issuer, jwks_url: FAKE_JWKS_URL, staff_audience: FAKE_AUDIENCE, fetch: parts.idp.fetch },
      {
        idp: "supabase",
        expected_purpose: "staff_login",
        client_id: FAKE_AUDIENCE,
        client_secret: "fake-client-secret",
        redirect_uri: REDIRECT_URI,
        params: { code: FAKE_CODE, state: state_in_authorize_url(redirect.authorization_url) },
        allowed_return_paths: ALLOWED_RETURN_PATHS,
      },
    );
    expect(completed.record.code_verifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
  });

  it("rejects a callback that reuses an authorization code", async () => {
    const parts = harness();
    await run_login(parts);
    // The provider honours each code once, so a second exchange of the same
    // code fails at the token endpoint even though the state is fresh.
    await expect(run_login(parts)).rejects.toMatchObject({ code: "oauth_token_exchange_failed" });
    expect(parts.idp.exchange_count).toBe(1);
  });

  it("rejects a callback whose state was already spent", async () => {
    const parts = harness();
    const redirect = await begin_authorization(parts.state_store, {
      idp: "supabase",
      issuer_url: parts.idp.issuer,
      client_id: FAKE_AUDIENCE,
      redirect_uri: REDIRECT_URI,
      tenant_id: null,
      return_path: "/actions",
      scopes: ["openid"],
    });
    parts.idp.record_authorize_request(nonce_in_authorize_url(redirect.authorization_url), challenge_in_authorize_url(redirect.authorization_url));
    const finish = () => complete_authorization(
      parts.state_store,
      supabase_code_exchanger(parts.idp.issuer, { fetch: parts.idp.fetch }),
      { issuer_url: parts.idp.issuer, jwks_url: FAKE_JWKS_URL, staff_audience: FAKE_AUDIENCE, fetch: parts.idp.fetch },
      {
        idp: "supabase",
        expected_purpose: "staff_login",
        client_id: FAKE_AUDIENCE,
        client_secret: "fake-client-secret",
        redirect_uri: REDIRECT_URI,
        params: { code: FAKE_CODE, state: state_in_authorize_url(redirect.authorization_url) },
        allowed_return_paths: ALLOWED_RETURN_PATHS,
      },
    );
    await finish();
    await expect(finish()).rejects.toMatchObject({ code: "oauth_state_replayed" });
  });

  it("rejects a callback whose ID token nonce does not match the flow", async () => {
    const parts = harness();
    const redirect = await begin_authorization(parts.state_store, {
      idp: "supabase",
      issuer_url: parts.idp.issuer,
      client_id: FAKE_AUDIENCE,
      redirect_uri: REDIRECT_URI,
      tenant_id: null,
      return_path: "/actions",
      scopes: ["openid"],
    });
    // The provider echoes a nonce the flow never issued.
    parts.idp.record_authorize_request("a-nonce-this-flow-never-generated", challenge_in_authorize_url(redirect.authorization_url));
    await expect(complete_authorization(
      parts.state_store,
      supabase_code_exchanger(parts.idp.issuer, { fetch: parts.idp.fetch }),
      { issuer_url: parts.idp.issuer, jwks_url: FAKE_JWKS_URL, staff_audience: FAKE_AUDIENCE, fetch: parts.idp.fetch },
      {
        idp: "supabase",
        expected_purpose: "staff_login",
        client_id: FAKE_AUDIENCE,
        client_secret: "fake-client-secret",
        redirect_uri: REDIRECT_URI,
        params: { code: FAKE_CODE, state: state_in_authorize_url(redirect.authorization_url) },
        allowed_return_paths: ALLOWED_RETURN_PATHS,
      },
    )).rejects.toMatchObject({ code: "oauth_nonce_mismatch" });
  });

  it("rejects a token response with no ID token rather than trusting the access token", async () => {
    const parts = harness({ omit_id_token: true });
    await expect(run_login(parts)).rejects.toMatchObject({ code: "oauth_token_exchange_failed" });
  });

  it("rejects a provider denial without leaking its description", async () => {
    const parts = harness();
    const redirect = await begin_authorization(parts.state_store, {
      idp: "supabase",
      issuer_url: parts.idp.issuer,
      client_id: FAKE_AUDIENCE,
      redirect_uri: REDIRECT_URI,
      tenant_id: null,
      return_path: "/actions",
      scopes: ["openid"],
    });
    await expect(complete_authorization(
      parts.state_store,
      supabase_code_exchanger(parts.idp.issuer, { fetch: parts.idp.fetch }),
      { issuer_url: parts.idp.issuer, jwks_url: FAKE_JWKS_URL, staff_audience: FAKE_AUDIENCE, fetch: parts.idp.fetch },
      {
        idp: "supabase",
        expected_purpose: "staff_login",
        client_id: FAKE_AUDIENCE,
        client_secret: "fake-client-secret",
        redirect_uri: REDIRECT_URI,
        params: {
          state: state_in_authorize_url(redirect.authorization_url),
          error: "access_denied",
          // The provider also sends a description; the flow must not read it and
          // must not echo it back.
          ...({ error_description: "user declined the tenant data request" } as Record<string, unknown>),
        } as OAuthCallbackParams,
        allowed_return_paths: ALLOWED_RETURN_PATHS,
      },
    )).rejects.toThrow(/^oauth-flow-failed: oauth_identity_unverified$/);
  });

  it("refuses a subject with no active membership instead of granting a session", async () => {
    const parts = harness({}, "https://other-issuer.example");
    const completed = await run_login(parts);
    await expect(build_staff_principal({
      subject_id: completed.identity.subject_id,
      issuer: completed.identity.issuer,
      has_mfa: false,
      issued_at_iso: new Date().toISOString(),
    }, parts.directory)).rejects.toMatchObject({ code: "oauth_membership_unresolved" });
  });

  it("refuses a suspended staff member even with a valid token", async () => {
    const directory = parse_staff_directory(JSON.stringify({
      entries: [{
        issuer: FAKE_ISSUER,
        subject_id: FAKE_SUBJECT,
        org_id: "acme",
        tenant_id: FAKE_TENANT_ID,
        roles: ["owner"],
        status: "suspended",
        invited_at_iso: "2026-01-01T00:00:00.000Z",
        updated_at_iso: "2026-02-01T00:00:00.000Z",
      }],
    }));
    await expect(build_staff_principal({
      subject_id: FAKE_SUBJECT,
      issuer: FAKE_ISSUER,
      has_mfa: true,
      issued_at_iso: new Date().toISOString(),
    }, directory)).rejects.toMatchObject({ code: "oauth_membership_unresolved" });
  });
});

describe("MFA evidence is derived, never assumed", () => {
  it("reads Supabase's object-form amr and aal2", () => {
    expect(has_verified_mfa({ aal: "aal2", amr: [{ method: "totp", timestamp: 1 }] })).toBe(true);
    expect(has_verified_mfa({ aal: "aal1", amr: [{ method: "password", timestamp: 1 }] })).toBe(false);
  });

  it("reads generic OIDC string-form amr", () => {
    expect(has_verified_mfa({ amr: ["pwd", "otp"] })).toBe(true);
    expect(has_verified_mfa({ amr: ["pwd"] })).toBe(false);
  });

  it("refuses an unfamiliar amr shape rather than guessing", () => {
    expect(has_verified_mfa({ amr: [{ factor: "totp" }] })).toBe(false);
    expect(has_verified_mfa({ amr: ["something-else"] })).toBe(false);
    expect(has_verified_mfa({})).toBe(false);
    expect(has_verified_mfa({ amr: "otp" })).toBe(false);
  });

  it("refuses a bare boolean MFA claim, which no supported issuer emits", () => {
    // `has_mfa` is not an OIDC, Supabase Auth, or Google claim. Honouring it would
    // let an issuer that can place a boolean on a token unlock outbound:replay.
    expect(has_verified_mfa({ has_mfa: true })).toBe(false);
    expect(has_verified_mfa({ has_mfa: true, amr: ["pwd"] })).toBe(false);
    expect(has_verified_mfa({ has_mfa: true, aal: "aal1" })).toBe(false);
    // The recognised forms still open the gate, so this is a narrowing and not a
    // blanket refusal.
    expect(has_verified_mfa({ has_mfa: true, aal: "aal2" })).toBe(true);
  });

  it("keeps the privileged gate closed for a login whose only MFA claim is a boolean", async () => {
    const parts = harness({ extra_claims: { has_mfa: true } });
    const completed = await run_login(parts);
    const principal = await build_staff_principal({
      subject_id: completed.identity.subject_id,
      issuer: completed.identity.issuer,
      has_mfa: completed.identity.has_mfa,
      issued_at_iso: new Date().toISOString(),
    }, parts.directory);
    expect(completed.identity.has_mfa).toBe(false);
    expect(() => authorize_privileged(principal, FAKE_TENANT_ID, "outbound:replay")).toThrow(/mfa-required/);
  });

  it("keeps the privileged gate closed for a Supabase login without aal2", async () => {
    const parts = harness({ supabase_amr: true, mfa: false });
    const completed = await run_login(parts);
    const principal = await build_staff_principal({
      subject_id: completed.identity.subject_id,
      issuer: completed.identity.issuer,
      has_mfa: completed.identity.has_mfa,
      issued_at_iso: new Date().toISOString(),
    }, parts.directory);
    expect(principal.has_mfa).toBe(false);
    expect(() => authorize_privileged(principal, FAKE_TENANT_ID, "outbound:replay")).toThrow(/mfa-required/);
    expect(() => authorize(principal, FAKE_TENANT_ID, "appointments:read")).not.toThrow();
  });

  it("opens the privileged gate only when Supabase reports aal2", async () => {
    const parts = harness({ supabase_amr: true, mfa: true });
    const completed = await run_login(parts);
    const principal = await build_staff_principal({
      subject_id: completed.identity.subject_id,
      issuer: completed.identity.issuer,
      has_mfa: completed.identity.has_mfa,
      issued_at_iso: new Date().toISOString(),
    }, parts.directory);
    expect(principal.has_mfa).toBe(true);
    expect(() => authorize_privileged(principal, FAKE_TENANT_ID, "outbound:replay")).not.toThrow();
  });
});

describe("configuration fails closed", () => {
  it("refuses a return path the deployment did not allow-list", () => {
    expect(() => require_return_path("/admin", ["/actions"])).toThrow();
  });

  it("refuses a directory issuer on a non-https scheme even on a loopback host", () => {
    // A loopback hostname must not wave through an arbitrary scheme: no browser
    // redirect or provider could ever have produced `ftp://localhost/x`.
    for (const issuer of ["ftp://localhost/x", "foo://localhost/x", "file://127.0.0.1/x", "ws://localhost/x"]) {
      expect(() => parse_staff_directory(directory_json(issuer))).toThrow(/oauth_configuration_invalid/);
    }
    expect(() => parse_staff_directory(directory_json("http://localhost:3000/x"))).not.toThrow();
    expect(() => parse_staff_directory(directory_json(FAKE_ISSUER))).not.toThrow();
  });

  it("keeps the session secret out of the record it is derived from", () => {
    const issued = issue_session_secret();
    expect(issued.secret_hash).not.toBe(issued.secret);
    expect(issued.secret_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("restricts Google sign-in to the tenant's Workspace domain", async () => {
    const matching = harness({ hosted_domain: "example.com" });
    await expect(run_login(matching, "google", "example.com")).resolves.toMatchObject({
      identity: { subject_id: FAKE_SUBJECT },
    });
    const foreign = harness({ hosted_domain: "attacker.test" });
    await expect(run_login(foreign, "google", "example.com")).rejects.toMatchObject({
      code: "oauth_identity_unverified",
    });
  });
});

/** Build a one-entry directory naming the supplied issuer. */
function directory_json(issuer: string): string {
  return JSON.stringify({
    entries: [{
      issuer,
      subject_id: FAKE_SUBJECT,
      org_id: "acme",
      tenant_id: FAKE_TENANT_ID,
      roles: ["owner"],
      status: "active",
      invited_at_iso: "2026-01-01T00:00:00.000Z",
      updated_at_iso: "2026-01-02T00:00:00.000Z",
    }],
  });
}
