/**
 * The signature on the wire must be the agent's own HMAC over the exact bytes.
 *
 * The round trip uses the agent's `is_valid_signature` rather than a
 * re-implementation, so a divergence in prefix, encoding, or digest would fail
 * here rather than as a 401 nobody can explain.
 */

import { describe, expect, it } from "vitest";
import { compute_signature_hex, is_valid_signature, SIGNATURE_PREFIX } from "appointment-agent/dist/src/ingress/verify.js";
import { post_signed_delivery, SIGNATURE_HEADER, SignedDeliveryError, type FetchLike } from "../src/signed_delivery.js";

const APP_SECRET = "synthetic-local-app-secret-value";
const RAW_BODY = '{"object":"whatsapp_business_account"}';

interface Captured {
  url: string;
  signature: string;
  body: string;
}

function capture(response: () => Response): { fetch: FetchLike; captured: Captured[] } {
  const captured: Captured[] = [];
  const fetch: FetchLike = async (url, init) => {
    const headers = init.headers as Record<string, string>;
    captured.push({ url, signature: headers[SIGNATURE_HEADER] ?? "", body: String(init.body ?? "") });
    return response();
  };
  return { fetch, captured };
}

function json_response(status: number, value: unknown): () => Response {
  return () => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function config(fetch_impl?: FetchLike) {
  return {
    agent_base_url: "http://127.0.0.1:3011",
    webhook_path: "/webhooks/whatsapp",
    app_secret: APP_SECRET,
    ...(fetch_impl === undefined ? {} : { fetch: fetch_impl }),
  };
}

const INGRESS_BODY = {
  request_id: "6f1c1a52-0000-4000-8000-000000000001",
  received_count: 1,
  duplicate_count: 0,
  enqueued_count: 1,
  unresolved_count: 0,
  status_count: 0,
};

describe("signature computation", () => {
  it("produces a header the agent's verifier accepts", () => {
    const header = `${SIGNATURE_PREFIX}${compute_signature_hex(RAW_BODY, APP_SECRET)}`;
    expect(header).toMatch(/^sha256=[0-9a-f]{64}$/u);
    expect(is_valid_signature(RAW_BODY, header, APP_SECRET)).toBe(true);
  });

  it("sends exactly the bytes it signed", async () => {
    const { fetch, captured } = capture(json_response(200, INGRESS_BODY));
    await post_signed_delivery(config(fetch), RAW_BODY);
    expect(captured[0]?.body).toBe(RAW_BODY);
    expect(captured[0]?.url).toBe("http://127.0.0.1:3011/webhooks/whatsapp");
  });

  it("signs the body, so a different body would not verify", async () => {
    const { fetch, captured } = capture(json_response(200, INGRESS_BODY));
    await post_signed_delivery(config(fetch), RAW_BODY);
    expect(is_valid_signature("{}", captured[0]?.signature ?? "", APP_SECRET)).toBe(false);
  });

  it("sends an all-zero digest for the deliberate self-check", async () => {
    const { fetch, captured } = capture(json_response(401, { error: "unauthorized" }));
    await post_signed_delivery(config(fetch), RAW_BODY, { enabled: true });
    expect(captured[0]?.signature).toBe(`${SIGNATURE_PREFIX}${"0".repeat(64)}`);
    expect(is_valid_signature(RAW_BODY, captured[0]?.signature ?? "", APP_SECRET)).toBe(false);
  });
});

describe("response reduction", () => {
  it("returns the agent's own ingress counters on success", async () => {
    const { fetch } = capture(json_response(200, INGRESS_BODY));
    const result = await post_signed_delivery(config(fetch), RAW_BODY);
    expect(result.http_status).toBe(200);
    expect(result.ingress).toEqual(INGRESS_BODY);
  });

  it("relays only the counters it understands, not the whole body", async () => {
    const { fetch } = capture(json_response(200, { ...INGRESS_BODY, recipient: "+15550100001" }));
    const result = await post_signed_delivery(config(fetch), RAW_BODY);
    expect(result.ingress).toEqual(INGRESS_BODY);
  });

  it("relays only a known ingress error token", async () => {
    const { fetch } = capture(json_response(401, { error: "unauthorized" }));
    expect(await post_signed_delivery(config(fetch), RAW_BODY)).toEqual({
      http_status: 401,
      error: "unauthorized",
    });
  });

  it("drops an unexpected upstream error string instead of relaying it", async () => {
    const { fetch } = capture(json_response(500, { error: "postgres://user:pass@host" }));
    expect(await post_signed_delivery(config(fetch), RAW_BODY)).toEqual({ http_status: 500 });
  });

  it("never returns the app secret it signed with", async () => {
    const { fetch } = capture(json_response(200, INGRESS_BODY));
    const result = await post_signed_delivery(config(fetch), RAW_BODY);
    expect(JSON.stringify(result)).not.toContain(APP_SECRET);
  });

  it("fails closed when no transport is available", async () => {
    await expect(post_signed_delivery(config(async () => {
      throw new Error("ECONNREFUSED");
    }), RAW_BODY)).rejects.toBeInstanceOf(SignedDeliveryError);
  });

  it("refuses to sign without a secret", async () => {
    await expect(post_signed_delivery({ ...config(), app_secret: "" }, RAW_BODY))
      .rejects.toBeInstanceOf(SignedDeliveryError);
  });
});
