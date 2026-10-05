/**
 * The browser-side security controls the OAuth surface depends on.
 *
 * The dashboard carries a session cookie, renders operator actions, and exposes a
 * logout control, and none of that used to be expressed to the browser: no CSP, no
 * HSTS, no framing control, no referrer or content-type policy. These assertions
 * cover the policy itself; the evidence that the policy does not break the running
 * app is a separate, real-server check, because a header set that blanks the
 * workspace would be worse than no header set at all.
 *
 * The deployment-shape conditions matter as much as the directives. A loopback
 * developer running over plain http must not receive a pinning header, because
 * there is no https listener to pin to and the browser would refuse every later
 * request — local development would be bricked by a security control.
 */

import { describe, expect, it } from "vitest";
import { security_headers } from "../security_headers.mjs";
import next_config from "../next.config.mjs";

/** The header map for one deployment shape, keyed by header name. */
function headers_for(options: { public_base_url?: string; is_production: boolean }): Map<string, string> {
  const entries = security_headers(options);
  expect(entries).toHaveLength(1);
  return new Map(entries[0].headers.map((header: { key: string; value: string }) => [header.key, header.value]));
}

/** Split a CSP value into its directives for order-independent assertions. */
function directives(policy: string): Map<string, string[]> {
  return new Map(policy.split(";").map((part) => {
    const [name, ...values] = part.trim().split(/\s+/);
    return [name, values];
  }));
}

const PUBLIC_HTTPS = "https://staff.example.com";

describe("the security header set", () => {
  it("covers every route, including the auth handlers", () => {
    const entries = security_headers({ public_base_url: PUBLIC_HTTPS, is_production: true });
    // One `/:path*` entry is what makes the logout route — the one route that
    // clears a credential — protected as well as the documents.
    expect(entries[0].source).toBe("/:path*");
    const names = entries[0].headers.map((header: { key: string }) => header.key);
    for (const required of [
      "Content-Security-Policy",
      "Strict-Transport-Security",
      "X-Frame-Options",
      "Referrer-Policy",
      "X-Content-Type-Options",
    ]) {
      expect(names, required).toContain(required);
    }
  });

  it("pins default-src to self and denies framing and base-uri rewriting", () => {
    const policy = directives(headers_for({ public_base_url: PUBLIC_HTTPS, is_production: true })
      .get("Content-Security-Policy") as string);
    expect(policy.get("default-src")).toEqual(["'self'"]);
    expect(policy.get("object-src")).toEqual(["'none'"]);
    // `frame-ancestors` duplicates X-Frame-Options deliberately: the header predates
    // CSP and is the only one an older browser honours.
    expect(policy.get("frame-ancestors")).toEqual(["'none'"]);
    expect(policy.get("base-uri")).toEqual(["'none'"]);
    expect(policy.get("form-action")).toEqual(["'self'"]);
  });

  it("denies framing, referrers, and content sniffing as headers too", () => {
    const headers = headers_for({ public_base_url: PUBLIC_HTTPS, is_production: true });
    expect(headers.get("X-Frame-Options")).toBe("DENY");
    expect(headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("Strict-Transport-Security")).toBe("max-age=63072000; includeSubDomains");
  });

  it("adds upgrade-insecure-requests only for an https origin", () => {
    const secure = headers_for({ public_base_url: PUBLIC_HTTPS, is_production: true })
      .get("Content-Security-Policy") as string;
    expect(directives(secure).has("upgrade-insecure-requests")).toBe(true);
    const insecure = headers_for({ public_base_url: "http://staff.example.com", is_production: true })
      .get("Content-Security-Policy") as string;
    // Upgrading an http-only development origin would send the browser somewhere
    // with no listener.
    expect(directives(insecure).has("upgrade-insecure-requests")).toBe(false);
  });

  it("keeps the policy capable of loading the app's own inline scripts and styles", () => {
    const policy = directives(headers_for({ public_base_url: PUBLIC_HTTPS, is_production: true })
      .get("Content-Security-Policy") as string);
    // Next's App Router emits inline bootstrap scripts and the design system injects
    // inline styles. Blocking them produces a blank page, so this is a deliberate
    // acceptance with a nonce-based policy as the follow-up.
    expect(policy.get("script-src")).toContain("'self'");
    expect(policy.get("script-src")).toContain("'unsafe-inline'");
    expect(policy.get("style-src")).toContain("'unsafe-inline'");
    expect(policy.get("connect-src")).toEqual(["'self'"]);
    // Production must not inherit the dev server's relaxed sources.
    expect(policy.get("script-src")).not.toContain("'unsafe-eval'");
    expect(policy.get("connect-src")).not.toContain("ws:");
  });

  it("relaxes only what the development server needs", () => {
    const policy = directives(headers_for({ public_base_url: "http://127.0.0.1:3000", is_production: false })
      .get("Content-Security-Policy") as string);
    expect(policy.get("script-src")).toContain("'unsafe-eval'");
    expect(policy.get("connect-src")).toContain("ws:");
    expect(policy.get("connect-src")).toContain("wss:");
  });
});

describe("transport security never bricks a loopback deployment", () => {
  it("omits HSTS for the plain-http loopback origin this repo develops against", () => {
    const headers = headers_for({ public_base_url: "http://127.0.0.1:3000", is_production: true });
    // The pinned-but-unreachable failure this prevents: a browser that refuses to
    // fall back to http for an origin with no https listener.
    expect(headers.has("Strict-Transport-Security")).toBe(false);
    expect(headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("omits HSTS for https on loopback, where a pin buys nothing", () => {
    for (const origin of ["https://127.0.0.1:3000", "https://localhost:3000", "https://[::1]:3000"]) {
      expect(headers_for({ public_base_url: origin, is_production: true }).has("Strict-Transport-Security"), origin)
        .toBe(false);
    }
  });

  it("omits HSTS when no public origin is configured rather than guessing one", () => {
    for (const public_base_url of [undefined, "", "   ", "not a url", "ftp://staff.example.com"]) {
      expect(headers_for({ public_base_url, is_production: true }).has("Strict-Transport-Security"), String(public_base_url))
        .toBe(false);
    }
  });
});

describe("the Next configuration actually serves them", () => {
  it("wires the policy through headers() and keeps poweredByHeader off", () => {
    // The policy is only evidence if the app ships it; a helper nothing calls would
    // leave the surface exactly as unprotected as before.
    expect(typeof next_config.headers).toBe("function");
    const headers_option = next_config.headers as unknown as () => Array<{
      source: string;
      headers: Array<{ key: string; value: string }>;
    }>;
    const served = headers_option();
    expect(served).toHaveLength(1);
    expect(served[0].source).toBe("/:path*");
    const names = served[0].headers.map((header: { key: string }) => header.key);
    expect(names).toContain("Content-Security-Policy");
    expect(names).toContain("X-Frame-Options");
    expect(names).toContain("Referrer-Policy");
    expect(names).toContain("X-Content-Type-Options");
    // Next would otherwise advertise the framework version on every response.
    expect(next_config.poweredByHeader).toBe(false);
    expect(next_config.reactStrictMode).toBe(true);
    expect(next_config.agentRules).toBe(false);
  });
});

describe("the header values carry nothing sensitive", () => {
  it("emits no cookie, token, or secret material", () => {
    for (const is_production of [true, false]) {
      const entries = security_headers({ public_base_url: PUBLIC_HTTPS, is_production });
      for (const header of entries[0].headers) {
        const value = String(header.value);
        for (const marker of ["sel_session", "Bearer", "eyJ", "1//", "client_secret", "refresh_token", "code="]) {
          expect(value, `${header.key}/${marker}`).not.toContain(marker);
        }
        // A CR or LF here would let a header value inject another one.
        expect(value).not.toMatch(/[\r\n]/u);
      }
    }
  });
});
