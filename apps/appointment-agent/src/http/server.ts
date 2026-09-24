import {
  createServer,
  type IncomingMessage,
  type Server as NodeHttpServer,
  type ServerResponse,
} from "node:http";
import type { MessageDedupeStore } from "../ingress/dedupe.js";
import type { InboundMessageStore } from "../ingress/inbound_store.js";
import type { AtomicIngressStore } from "../ingress/postgres_atomic_ingress.js";
import type { TenantResolver } from "../ingress/tenant_resolver.js";
import type { RecipientCipher } from "../security/recipient_cipher.js";
import {
  is_valid_signature,
} from "../ingress/verify.js";
import {
  MAX_WEBHOOK_BYTES,
  WebhookSignatureError,
  generate_request_id,
  handle_inbound_request,
  handle_verification_request,
  type InboundHandleResult,
  type WebhookJobQueue,
} from "../webhook_handler.js";
import {
  MethodNotAllowedError,
  RequestDeadlineError,
  HTTP_STATUS,
  error_response,
  json_response,
  send_response,
  text_response,
  type HttpResponse,
} from "./http_response.js";
import {
  assert_content_length_allowed,
  get_single_header,
  read_raw_body,
} from "./request_body.js";

export const WEBHOOK_PATH = "/webhooks/whatsapp";
export const HEALTH_PATH = "/healthz";
export const DEFAULT_SERVER_PORT = 3000;
export const DEFAULT_SERVER_HOST = "0.0.0.0";
export const WEBHOOK_RESPONSE_DEADLINE_MS = 2_500;
const HEADERS_TIMEOUT_MS = 2_000;

/** Runtime configuration loaded from environment variables by the composition root. */
export interface HttpServerConfig {
  port: number;
  host: string;
  verify_token: string;
  app_secret: string;
}

/** Injectable ingress dependencies; the server owns HTTP framing only. */
export interface HttpServerDependencies {
  dedupe_store: MessageDedupeStore;
  job_queue: WebhookJobQueue;
  atomic_ingress?: AtomicIngressStore;
  tenant_resolver?: TenantResolver;
  inbound_store?: InboundMessageStore;
  recipient_cipher?: RecipientCipher;
  inbound_retention_days?: number;
  inbound_handler?: typeof handle_inbound_request;
}

type InboundHandler = typeof handle_inbound_request;

/** Signals invalid server configuration without exposing a secret value. */
export class ServerConfigurationError extends Error {
  constructor() {
    super("server-configuration-invalid");
    this.name = "ServerConfigurationError";
  }
}

function parse_port(raw_port: string | undefined): number {
  if (raw_port === undefined || raw_port.trim() === "") {
    return DEFAULT_SERVER_PORT;
  }
  const port = Number(raw_port);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new ServerConfigurationError();
  }
  return port;
}

/**
 * Load and validate server settings from environment variables.
 *
 * Args:
 *   env: Environment mapping; defaults to the process environment.
 *
 * Returns:
 *   Port, host, verification token, and HMAC secret for the HTTP adapter.
 *
 * Raises:
 *   ServerConfigurationError: If a required secret or port setting is invalid.
 */
export function load_server_config(
  env: Record<string, string | undefined> = process.env,
): HttpServerConfig {
  const verify_token = env["WHATSAPP_VERIFY_TOKEN"];
  const app_secret = env["WHATSAPP_APP_SECRET"];
  if (
    verify_token === undefined ||
    verify_token === "" ||
    app_secret === undefined ||
    app_secret === ""
  ) {
    throw new ServerConfigurationError();
  }
  const host = env["HOST"] ?? env["SERVER_HOST"] ?? DEFAULT_SERVER_HOST;
  if (host.trim() === "") throw new ServerConfigurationError();
  return {
    port: parse_port(env["PORT"]),
    host,
    verify_token,
    app_secret,
  };
}

function verification_response(
  request: IncomingMessage,
  config: HttpServerConfig,
): HttpResponse {
  const params = new URL(request.url ?? "/", "http://localhost").searchParams;
  const challenge = handle_verification_request(
    {
      hub_mode: params.get("hub.mode") ?? undefined,
      hub_verify_token: params.get("hub.verify_token") ?? undefined,
      hub_challenge: params.get("hub.challenge") ?? undefined,
    },
    config.verify_token,
  );
  return text_response(HTTP_STATUS.OK, challenge);
}

async function webhook_response(
  request: IncomingMessage,
  config: HttpServerConfig,
  dependencies: HttpServerDependencies,
  signal?: AbortSignal,
): Promise<HttpResponse> {
  assert_content_length_allowed(request, MAX_WEBHOOK_BYTES);
  const raw_body = await read_raw_body(request, MAX_WEBHOOK_BYTES);
  const signature = get_single_header(request, "x-hub-signature-256");
  // Reject at the HTTP boundary; the handler repeats the invariant for other callers.
  if (!is_valid_signature(raw_body, signature, config.app_secret)) {
    throw new WebhookSignatureError();
  }
  const handler: InboundHandler = dependencies.inbound_handler ?? handle_inbound_request;
  const result: InboundHandleResult = await handler(
    raw_body,
    signature,
    config.app_secret,
    dependencies.dedupe_store,
    dependencies.job_queue,
    {
      tenant_resolver: dependencies.tenant_resolver,
      atomic_ingress: dependencies.atomic_ingress,
      signal,
      inbound_store: dependencies.inbound_store,
      recipient_cipher: dependencies.recipient_cipher,
      retention_days: dependencies.inbound_retention_days,
    },
  );
  return json_response(HTTP_STATUS.OK, result);
}

function with_deadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeout_ms: number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      reject(new RequestDeadlineError());
    }, timeout_ms);
    void operation(controller.signal).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function create_response(
  request: IncomingMessage,
  config: HttpServerConfig,
  dependencies: HttpServerDependencies,
): Promise<HttpResponse> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const method = request.method ?? "";
  if (url.pathname === HEALTH_PATH) {
    if (method !== "GET") throw new MethodNotAllowedError("GET");
    return text_response(HTTP_STATUS.OK, "ok");
  }
  if (url.pathname !== WEBHOOK_PATH) return json_response(HTTP_STATUS.NOT_FOUND, { error: "not_found" });
  if (method === "GET") return verification_response(request, config);
  if (method === "POST") {
    return with_deadline(
      (signal) => webhook_response(request, config, dependencies, signal),
      WEBHOOK_RESPONSE_DEADLINE_MS,
    );
  }
  throw new MethodNotAllowedError("GET, POST");
}

function safe_path(request: IncomingMessage): string {
  try {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    return path === WEBHOOK_PATH || path === HEALTH_PATH ? path : "unknown";
  } catch {
    return "unknown";
  }
}

function log_server_error(
  request: IncomingMessage,
  request_id: string,
  status: number,
  error: unknown,
): void {
  if (status < 500) return;
  const error_name = error instanceof Error ? error.name : "UnknownError";
  console.error(
    JSON.stringify({
      event: "webhook_request_error",
      request_id,
      method: request.method ?? "",
      path: safe_path(request),
      status,
      error_name,
    }),
  );
}

async function handle_http_request(
  request: IncomingMessage,
  response: ServerResponse,
  config: HttpServerConfig,
  dependencies: HttpServerDependencies,
): Promise<void> {
  const request_id = generate_request_id();
  try {
    const result = await create_response(request, config, dependencies);
    send_response(response, result);
  } catch (error) {
    const result = error_response(error);
    log_server_error(request, request_id, result.status, error);
    send_response(response, result);
  }
}

/**
 * Create the dependency-injected Node HTTP webhook server.
 *
 * Args:
 *   config: Validated port, host, verification token, and app secret.
 *   dependencies: Dedupe store, queue, and optional handler override for tests.
 *
 * Returns:
 *   A Node HTTP server that has not been started.
 */
export function create_http_server(
  config: HttpServerConfig,
  dependencies: HttpServerDependencies,
): NodeHttpServer {
  return createServer(
    { headersTimeout: HEADERS_TIMEOUT_MS, requestTimeout: WEBHOOK_RESPONSE_DEADLINE_MS + 500 },
    (request, response) => {
      void handle_http_request(request, response, config, dependencies).catch(() => {
        if (!response.headersSent && !response.writableEnded) {
          send_response(response, json_response(HTTP_STATUS.INTERNAL_SERVER_ERROR, { error: "internal_server_error" }));
        }
      });
    },
  );
}

/**
 * Start the HTTP server and resolve once it is listening.
 *
 * Args:
 *   config: Validated server settings.
 *   dependencies: Ingress dependencies supplied to the request handler.
 *
 * Returns:
 *   The listening Node HTTP server.
 *
 * Raises:
 *   Error: Propagates a listen failure so startup can fail closed.
 */
export async function start_http_server(
  config: HttpServerConfig,
  dependencies: HttpServerDependencies,
): Promise<NodeHttpServer> {
  const server = create_http_server(config, dependencies);
  await new Promise<void>((resolve, reject) => {
    const on_error = (error: Error): void => {
      server.off("listening", on_listening);
      reject(error);
    };
    const on_listening = (): void => {
      server.off("error", on_error);
      resolve();
    };
    server.once("error", on_error);
    server.once("listening", on_listening);
    server.listen(config.port, config.host);
  });
  return server;
}
