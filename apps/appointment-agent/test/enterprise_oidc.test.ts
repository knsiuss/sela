import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  create_signing_key_set,
  OidcJwtVerifier,
  oidc_verifier_from_env,
  supabase_oidc_options_from_env,
  verify_rs256_jwt,
} from "../src/enterprise/oidc_verifier.js";

const NOW_MS = Date.parse("2026-09-25T00:00:00.000Z");

describe("OIDC verification boundaries", () => {
  it("verifies an RS256 OIDC token against a cached JWKS and maps MFA roles", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
    const header = base64url(JSON.stringify({ alg: "RS256", kid: "test-key", typ: "JWT" }));
    const payload = base64url(JSON.stringify({
      iss: "https://issuer.example",
      aud: "appointment-api",
      sub: "operator-1",
      sid: "session-1",
      iat: Math.floor(NOW_MS / 1_000),
      exp: Math.floor(NOW_MS / 1_000) + 300,
      amr: ["pwd", "mfa"],
      tenant_roles: { "42": ["operator"] },
    }));
    const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
    const fetch_mock = vi.fn(async () => new Response(JSON.stringify({
      keys: [{ ...jwk, kid: "test-key", alg: "RS256", use: "sig" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const verifier = new OidcJwtVerifier({
      issuer_url: "https://issuer.example",
      jwks_url: "https://issuer.example/jwks",
      audience: "appointment-api",
      fetch: fetch_mock,
      clock: () => NOW_MS,
    });

    await expect(verifier.verify(`${header}.${payload}.${signature}`)).resolves.toMatchObject({
      subject_id: "operator-1",
      has_mfa: true,
      tenant_roles: { "42": ["operator"] },
    });
    const unknown_header = base64url(JSON.stringify({ alg: "RS256", kid: "unknown-key", typ: "JWT" }));
    const unknown_signature = sign(
      "RSA-SHA256",
      Buffer.from(`${unknown_header}.${payload}`),
      privateKey,
    ).toString("base64url");
    await expect(verifier.verify(`${unknown_header}.${payload}.${unknown_signature}`))
      .rejects.toMatchObject({ name: "AuthorizationError", code: "unauthenticated" });
    expect(fetch_mock).toHaveBeenCalledTimes(1);
  });

  it("rejects algorithm confusion and invalid registered claims before JWKS use", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
    const valid_payload = {
      iss: "https://issuer.example",
      aud: "appointment-api",
      sub: "operator-1",
      sid: "session-1",
      iat: Math.floor(NOW_MS / 1_000),
      exp: Math.floor(NOW_MS / 1_000) + 300,
      tenant_roles: { "42": ["operator"] },
    };
    const token = (header: Record<string, unknown>, payload: Record<string, unknown>): string => {
      const encoded_header = base64url(JSON.stringify(header));
      const encoded_payload = base64url(JSON.stringify(payload));
      const signature = sign("RSA-SHA256", Buffer.from(`${encoded_header}.${encoded_payload}`), privateKey)
        .toString("base64url");
      return `${encoded_header}.${encoded_payload}.${signature}`;
    };
    const fetch_mock = vi.fn(async () => new Response(JSON.stringify({
      keys: [{ ...jwk, kid: "test-key", alg: "RS256", use: "sig" }],
    }), { status: 200 }));
    const verifier = new OidcJwtVerifier({
      issuer_url: "https://issuer.example",
      jwks_url: "https://issuer.example/jwks",
      audience: "appointment-api",
      fetch: fetch_mock,
      clock: () => NOW_MS,
    });

    await expect(verifier.verify(token({ alg: "none", kid: "test-key" }, valid_payload)))
      .rejects.toMatchObject({ name: "AuthorizationError", code: "unauthenticated" });
    await expect(verifier.verify(token(
      { alg: "RS256", kid: "test-key" },
      { ...valid_payload, iss: "https://attacker.example" },
    ))).rejects.toMatchObject({ name: "AuthorizationError", code: "unauthenticated" });
    expect(fetch_mock).not.toHaveBeenCalled();
  });

  it("builds a Supabase Auth verifier from env placeholders with synthetic JWKS", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
    const header = base64url(JSON.stringify({ alg: "RS256", kid: "supabase-key", typ: "JWT" }));
    const payload = base64url(JSON.stringify({
      iss: "https://placeholder.supabase.co/auth/v1",
      aud: "authenticated",
      sub: "operator-1",
      sid: "session-1",
      iat: Math.floor(NOW_MS / 1_000),
      exp: Math.floor(NOW_MS / 1_000) + 300,
      amr: ["otp"],
      tenant_roles: { "42": ["admin"] },
    }));
    const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
    const fetch_mock = vi.fn(async () => new Response(JSON.stringify({
      keys: [{ ...jwk, kid: "supabase-key", alg: "RS256", use: "sig" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const verifier = oidc_verifier_from_env({
      SUPABASE_AUTH_ISSUER_URL: "https://placeholder.supabase.co/auth/v1",
      SUPABASE_AUTH_JWKS_URL: "https://placeholder.supabase.co/auth/v1/.well-known/jwks.json",
      SUPABASE_AUTH_AUDIENCE: "authenticated",
    });
    const with_fetch = new OidcJwtVerifier({
      ...(supabase_oidc_options_from_env({
        SUPABASE_AUTH_ISSUER_URL: "https://placeholder.supabase.co/auth/v1",
        SUPABASE_AUTH_JWKS_URL: "https://placeholder.supabase.co/auth/v1/.well-known/jwks.json",
        SUPABASE_AUTH_AUDIENCE: "authenticated",
      })!),
      fetch: fetch_mock,
      clock: () => NOW_MS,
    });
    expect(verifier).toBeInstanceOf(OidcJwtVerifier);
    await expect(with_fetch.verify(`${header}.${payload}.${signature}`)).resolves.toMatchObject({
      subject_id: "operator-1",
      has_mfa: true,
      tenant_roles: { "42": ["admin"] },
    });
    expect(fetch_mock).toHaveBeenCalledTimes(1);
  });

  it("fails closed when OIDC and Supabase Auth configuration are absent or partial", () => {
    expect(supabase_oidc_options_from_env({})).toBeUndefined();
    expect(() => oidc_verifier_from_env({})).toThrow("oidc-environment-required");
    expect(() => supabase_oidc_options_from_env({
      SUPABASE_AUTH_ISSUER_URL: "https://placeholder.supabase.co/auth/v1",
    })).toThrow("oidc-environment-required");
    expect(() => oidc_verifier_from_env({
      OIDC_ISSUER_URL: "https://issuer.example",
    })).toThrow("oidc-environment-required");
  });

  it("treats a bare has_mfa boolean as unverified on the operator bearer path", async () => {
    const verifier = bearer_verifier();
    // A verified signature is not MFA evidence: the claim is not one any
    // supported issuer emits, so honouring it would self-assert a second factor
    // and unlock outbound:replay from the operator API.
    await expect(verifier.verify(signed_token({ has_mfa: true }))).resolves.toMatchObject({ has_mfa: false });
    await expect(verifier.verify(signed_token({ has_mfa: true, aal: "aal2" })))
      .resolves.toMatchObject({ has_mfa: true });
  });

  it("reuses one JWKS fetch across verifications when the key set is shared", async () => {
    jwks_fetches = 0;
    const key_set = create_signing_key_set({
      ...SHARED_JWT_OPTIONS,
      fetch: counting_fetch,
      clock: () => NOW_MS,
    });
    const options = { ...SHARED_JWT_OPTIONS, key_set, clock: () => NOW_MS };
    await verify_rs256_jwt(signed_token(), options);
    await verify_rs256_jwt(signed_token(), options);
    // A key set built per call would refetch, which is exactly the outbound
    // request on every staff login that the shared set removes.
    expect(jwks_fetches).toBe(1);
  });

  it("fetches the JWKS once per verification when no key set is supplied", async () => {
    jwks_fetches = 0;
    const options = { ...SHARED_JWT_OPTIONS, fetch: counting_fetch, clock: () => NOW_MS };
    await verify_rs256_jwt(signed_token(), options);
    await verify_rs256_jwt(signed_token(), options);
    expect(jwks_fetches).toBe(2);
  });
});

/** JWKS requests counted across the assertions in this file. */
let jwks_fetches = 0;

/** Signing key shared by the generated tokens in this file. */
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });

const counting_fetch = vi.fn(async (input: string | URL | Request): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!url.pathname.endsWith("/jwks")) throw new Error("unexpected-endpoint");
  jwks_fetches += 1;
  const jwk = keys.publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  return new Response(JSON.stringify({ keys: [{ ...jwk, kid: "shared-key", alg: "RS256", use: "sig" }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});

/** Trust settings shared by the generated tokens in this file. */
const SHARED_JWT_OPTIONS = {
  issuer_url: "https://issuer.example",
  jwks_url: "https://issuer.example/jwks",
  audience: "appointment-api",
};

/** Build a bearer verifier over the shared key pair and counting fetch. */
function bearer_verifier(): OidcJwtVerifier {
  return new OidcJwtVerifier({ ...SHARED_JWT_OPTIONS, fetch: counting_fetch, clock: () => NOW_MS });
}

/** Sign a compact JWS carrying the shared key id and the given extra claims. */
function signed_token(claims: Record<string, unknown> = {}): string {
  const header = base64url(JSON.stringify({ alg: "RS256", kid: "shared-key", typ: "JWT" }));
  const payload = base64url(JSON.stringify({
    iss: "https://issuer.example",
    aud: "appointment-api",
    sub: "operator-1",
    sid: "session-1",
    iat: Math.floor(NOW_MS / 1_000),
    exp: Math.floor(NOW_MS / 1_000) + 300,
    tenant_roles: { "42": ["owner"] },
    ...claims,
  }));
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), keys.privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

function base64url(value: string): string {
  return Buffer.from(value).toString("base64url");
}
