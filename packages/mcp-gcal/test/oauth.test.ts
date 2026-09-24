import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleOAuthClient, GoogleOAuthError } from "../src/oauth.js";

const CLIENT_ID = "unit-client-id";
const CLIENT_SECRET = "unit-client-secret";
const REFRESH_TOKEN = "unit-refresh-token";
const ACCESS_TOKEN = "unit-access-token";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GoogleOAuthClient", () => {
  it("refreshes through a form body and caches by token key", async () => {
    const fetch_mock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: ACCESS_TOKEN, expires_in: 3600 }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetch_mock);
    const oauth = new GoogleOAuthClient({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      token_key: "tenant-a",
      refresh_token: REFRESH_TOKEN,
      fetch: fetch_mock,
      clock: () => 1_000,
    });

    await expect(oauth.get_access_token()).resolves.toBe(ACCESS_TOKEN);
    await expect(oauth.get_access_token()).resolves.toBe(ACCESS_TOKEN);

    expect(fetch_mock).toHaveBeenCalledOnce();
    const [url, init] = fetch_mock.mock.calls[0] ?? [];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect(String(url)).not.toContain(CLIENT_SECRET);
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      "Content-Type": "application/x-www-form-urlencoded",
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("client_id")).toBe(CLIENT_ID);
    expect(body.get("client_secret")).toBe(CLIENT_SECRET);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe(REFRESH_TOKEN);
  });

  it("keeps cached access tokens isolated by token key", async () => {
    const fetch_mock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "token-a", expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "token-b", expires_in: 3600 }), { status: 200 }));
    const oauth = new GoogleOAuthClient({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token_provider: (token_key) => `refresh-${token_key}`,
      fetch: fetch_mock,
    });

    await expect(oauth.get_access_token("tenant-a")).resolves.toBe("token-a");
    await expect(oauth.get_access_token("tenant-b")).resolves.toBe("token-b");
    await expect(oauth.get_access_token("tenant-a")).resolves.toBe("token-a");

    expect(fetch_mock).toHaveBeenCalledTimes(2);
  });

  it("shares one refresh between concurrent requests for one token key", async () => {
    let resolve_response: ((response: Response) => void) | undefined;
    const fetch_mock = vi.fn().mockImplementation(
      () => new Promise<Response>((resolve) => {
        resolve_response = resolve;
      }),
    );
    const oauth = new GoogleOAuthClient({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      token_key: "tenant-a",
      refresh_token: REFRESH_TOKEN,
      fetch: fetch_mock,
    });

    const first = oauth.get_access_token();
    const second = oauth.get_access_token();
    await Promise.resolve();
    expect(fetch_mock).toHaveBeenCalledOnce();
    resolve_response?.(new Response(JSON.stringify({ access_token: ACCESS_TOKEN, expires_in: 3600 }), { status: 200 }));

    await expect(Promise.all([first, second])).resolves.toEqual([ACCESS_TOKEN, ACCESS_TOKEN]);
    expect(fetch_mock).toHaveBeenCalledOnce();
  });

  it("does not expose a refresh secret or upstream body in an error", async () => {
    const fetch_mock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { status: "INVALID_GRANT", message: REFRESH_TOKEN } }), { status: 400 }),
    );
    const oauth = new GoogleOAuthClient({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      token_key: "tenant-a",
      refresh_token: REFRESH_TOKEN,
      fetch: fetch_mock,
    });

    await expect(oauth.get_access_token()).rejects.toMatchObject({
      code: "upstream_error",
      status: 400,
      code_upstream: "INVALID_GRANT",
    });
    await expect(oauth.get_access_token()).rejects.not.toThrow(REFRESH_TOKEN);
  });

  it("fails closed when a tenant refresh token is missing", async () => {
    const oauth = new GoogleOAuthClient({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      token_key: "tenant-a",
      fetch: vi.fn(),
    });

    await expect(oauth.get_access_token()).rejects.toBeInstanceOf(GoogleOAuthError);
  });
});
