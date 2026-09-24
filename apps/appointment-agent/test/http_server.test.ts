import { createHmac } from "node:crypto";
import { request as http_request, type RequestOptions } from "node:http";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { InMemoryMessageDedupe } from "../src/ingress/dedupe.js";
import { InMemoryInboundMessageStore } from "../src/ingress/inbound_store.js";
import { InMemoryTenantResolver } from "../src/ingress/tenant_resolver.js";
import { AesGcmRecipientCipher } from "../src/security/recipient_cipher.js";
import {
  create_http_server,
  load_server_config,
  ServerConfigurationError,
  type HttpServerConfig,
  type HttpServerDependencies,
} from "../src/http/server.js";
import { InMemoryWebhookQueue, MAX_WEBHOOK_BYTES } from "../src/webhook_handler.js";

const VERIFY_TOKEN = "verify-token-test";
const APP_SECRET = "app-secret-test";
const RECIPIENT_CIPHER = new AesGcmRecipientCipher(Buffer.alloc(32, 6));
const CONFIG: HttpServerConfig = {
  port: 0,
  host: "127.0.0.1",
  verify_token: VERIFY_TOKEN,
  app_secret: APP_SECRET,
};
const VALID_BODY = JSON.stringify({
  object: "whatsapp_business_account",
  entry: [
    {
      changes: [
        {
          value: {
            phone_number_id: "phone-http-test",
            messages: [
              {
                id: "wamid.http-test",
                from: "15551234567",
                type: "text",
                timestamp: "1780000000",
                text: { body: "hello" },
              },
            ],
          },
        },
      ],
    },
  ],
});

interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  elapsed_ms: number;
}

function signature_for(body: string): string {
  return `sha256=${createHmac("sha256", APP_SECRET).update(body).digest("hex")}`;
}

async function with_server<T>(
  dependencies: HttpServerDependencies,
  callback: (base_url: string) => Promise<T>,
): Promise<T> {
  const server = create_http_server(CONFIG, dependencies);
  await new Promise<void>((resolve) => server.listen(0, CONFIG.host, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("server-address-unavailable");
  }
  try {
    return await callback(`http://${CONFIG.host}:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
}

async function make_request(
  base_url: string,
  path: string,
  options: RequestOptions & { body?: Buffer | string } = {},
): Promise<HttpResult> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const request = http_request(`${base_url}${path}`, options, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => {
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString("utf8"),
          elapsed_ms: performance.now() - started,
        });
      });
    });
    request.once("error", reject);
    request.end(options.body);
  });
}

function dependencies(): HttpServerDependencies {
  return {
    dedupe_store: new InMemoryMessageDedupe(),
    inbound_store: new InMemoryInboundMessageStore(),
    recipient_cipher: RECIPIENT_CIPHER,
    tenant_resolver: new InMemoryTenantResolver({ "phone-http-test": "42" }),
    job_queue: new InMemoryWebhookQueue(),
  };
}

describe("server configuration", () => {
  it("fails closed when required secrets or port settings are invalid", () => {
    expect(() => load_server_config({})).toThrow(ServerConfigurationError);
    expect(() =>
      load_server_config({
        WHATSAPP_VERIFY_TOKEN: VERIFY_TOKEN,
        WHATSAPP_APP_SECRET: APP_SECRET,
        PORT: "70000",
      }),
    ).toThrow(ServerConfigurationError);
  });
});

describe("http webhook server", () => {
  it("answers the Meta verification challenge and rejects a wrong token", async () => {
    await with_server(dependencies(), async (base_url) => {
      const query = new URLSearchParams({
        "hub.mode": "subscribe",
        "hub.verify_token": VERIFY_TOKEN,
        "hub.challenge": "challenge-123",
      });
      const valid = await make_request(base_url, `/webhooks/whatsapp?${query}`);
      expect(valid.status).toBe(200);
      expect(valid.body).toBe("challenge-123");
      expect(valid.headers["cache-control"]).toBe("no-store");

      const invalid_query = new URLSearchParams({
        "hub.mode": "subscribe",
        "hub.verify_token": "wrong-token",
        "hub.challenge": "challenge-123",
      });
      const invalid = await make_request(base_url, `/webhooks/whatsapp?${invalid_query}`);
      expect(invalid.status).toBe(401);
      expect(invalid.body).not.toContain(VERIFY_TOKEN);
    });
  });

  it("accepts a signed payload and rejects a tampered payload", async () => {
    const queue = new InMemoryWebhookQueue();
    const inbound_store = new InMemoryInboundMessageStore();
    const server_dependencies = { ...dependencies(), inbound_store, job_queue: queue };
    await with_server(server_dependencies, async (base_url) => {
      const valid = await make_request(base_url, "/webhooks/whatsapp", {
        method: "POST",
        headers: { "x-hub-signature-256": signature_for(VALID_BODY) },
        body: VALID_BODY,
      });
      expect(valid.status).toBe(200);
      expect(JSON.parse(valid.body)).toMatchObject({
        received_count: 1,
        duplicate_count: 0,
        enqueued_count: 1,
      });
      expect(queue.pending_jobs()).toHaveLength(1);
      expect(queue.pending_jobs()[0]).toMatchObject({ tenant_id: "42" });
      expect(inbound_store.all()).toHaveLength(1);
      expect(inbound_store.all()[0]).toMatchObject({
        tenant_id: "42",
        wamid: "wamid.http-test",
        reply_target_ciphertext: expect.stringMatching(/^v1\./),
      });
      expect(JSON.stringify(inbound_store.all())).not.toContain("+15551234567");

      const tampered = await make_request(base_url, "/webhooks/whatsapp", {
        method: "POST",
        headers: { "x-hub-signature-256": signature_for(VALID_BODY) },
        body: `${VALID_BODY} `,
      });
      expect(tampered.status).toBe(401);
      expect(queue.pending_jobs()).toHaveLength(1);
      expect(queue.pending_jobs()[0]).toMatchObject({ tenant_id: "42" });
    });
  });

  it("returns 200 and skips an unknown channel without creating a job", async () => {
    const queue = new InMemoryWebhookQueue();
    const unknown_body = VALID_BODY.replace("phone-http-test", "phone-unknown");
    await with_server({ ...dependencies(), job_queue: queue }, async (base_url) => {
      const response = await make_request(base_url, "/webhooks/whatsapp", {
        method: "POST",
        headers: { "x-hub-signature-256": signature_for(unknown_body) },
        body: unknown_body,
      });

      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toMatchObject({
        received_count: 1,
        enqueued_count: 0,
        unresolved_count: 1,
      });
      expect(queue.pending_jobs()).toHaveLength(0);
    });
  });

  it("returns a safe 503 when the queue cannot persist a claimed job", async () => {
    const failing_queue = {
      enqueue: async (): Promise<void> => {
        throw new Error("database password and internal SQL");
      },
    };
    await with_server({ ...dependencies(), job_queue: failing_queue }, async (base_url) => {
      const response = await make_request(base_url, "/webhooks/whatsapp", {
        method: "POST",
        headers: { "x-hub-signature-256": signature_for(VALID_BODY) },
        body: VALID_BODY,
      });
      expect(response.status).toBe(503);
      expect(response.body).not.toContain("database password and internal SQL");
      expect(response.headers["cache-control"]).toBe("no-store");
    });
  });

  it("rejects a body over the configured maximum", async () => {
    await with_server(dependencies(), async (base_url) => {
      const oversized = Buffer.alloc(MAX_WEBHOOK_BYTES + 1, "x");
      const response = await make_request(base_url, "/webhooks/whatsapp", {
        method: "POST",
        headers: { "x-hub-signature-256": signature_for(oversized.toString("utf8")) },
        body: oversized,
      });
      expect(response.status).toBe(413);
      expect(response.elapsed_ms).toBeLessThan(3_000);
    });
  });

  it("exposes health and completes a signed request within the ACK budget", async () => {
    await with_server(dependencies(), async (base_url) => {
      const health = await make_request(base_url, "/healthz");
      expect(health.status).toBe(200);
      expect(health.body).toBe("ok");
      expect(health.headers["cache-control"]).toBe("no-store");

      const started = performance.now();
      const response = await make_request(base_url, "/webhooks/whatsapp", {
        method: "POST",
        headers: { "x-hub-signature-256": signature_for(VALID_BODY) },
        body: VALID_BODY,
      });
      expect(response.status).toBe(200);
      expect(performance.now() - started).toBeLessThan(3_000);
    });
  });
});
