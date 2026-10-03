/**
 * Coverage for Google token revocation.
 *
 * The revocation endpoint is Google's documented
 * `https://oauth2.googleapis.com/revoke`, and success is an HTTP 200 with an
 * empty body, which is why only the status is read. The error assertions matter
 * most: a revocation failure is an incident-response path, so the message must
 * identify the status without ever repeating the token being revoked.
 */

import { describe, expect, it, vi } from "vitest";
import { GOOGLE_REVOCATION_ENDPOINT, revoke_google_token } from "../src/oauth_revocation.js";
import { GoogleOAuthError } from "../src/oauth.js";

const TOKEN = "1//0eXa-refresh-token-value";

describe("Google revocation endpoint", () => {
  it("matches the published OAuth 2.0 server metadata", () => {
    expect(GOOGLE_REVOCATION_ENDPOINT).toBe("https://oauth2.googleapis.com/revoke");
  });
});

describe("revoke_google_token", () => {
  it("posts the token and accepts an empty 200 body", async () => {
    const fetch_mock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new URLSearchParams(String(init?.body ?? "")).get("token")).toBe(TOKEN);
      return new Response("", { status: 200 });
    });
    await expect(revoke_google_token({ token: TOKEN, fetch: fetch_mock })).resolves.toBeUndefined();
    expect(fetch_mock.mock.calls[0]?.[0]).toBe(GOOGLE_REVOCATION_ENDPOINT);
  });

  it("authenticates with the token alone, so no client secret can reach the wire", async () => {
    const fetch_mock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response("", { status: 200 }));
    await revoke_google_token({ token: TOKEN, fetch: fetch_mock });
    const sent = fetch_mock.mock.calls[0];
    const body = new URLSearchParams(String(sent?.[1]?.body ?? ""));
    expect([...body.keys()]).toEqual(["token"]);
    expect(JSON.stringify(sent?.[1])).not.toContain("secret");
  });

  it("reports an upstream failure without echoing the token", async () => {
    const attempt = revoke_google_token({
      token: TOKEN,
      fetch: vi.fn(async () => new Response("", { status: 400 })),
    });
    const message = await attempt.catch((error: Error) => error.message);
    expect(message).not.toContain(TOKEN);
    expect(message).toContain("status 400");
  });

  it("refuses a malformed token before making a request", async () => {
    const fetch_mock = vi.fn(async () => new Response("", { status: 200 }));
    for (const bad of ["", "not a token", "tok\nen"]) {
      await expect(revoke_google_token({ token: bad, fetch: fetch_mock })).rejects.toThrow(GoogleOAuthError);
    }
    expect(fetch_mock).not.toHaveBeenCalled();
  });

  it("reports a transport failure distinctly from an upstream rejection", async () => {
    const failed = revoke_google_token({
      token: TOKEN,
      fetch: vi.fn(async () => { throw new Error("network down"); }),
    });
    await expect(failed).rejects.toMatchObject({ code: "request_failed" });
  });
});
