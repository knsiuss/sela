/**
 * Loopback HTTP server for the local end-user chat surface.
 *
 * SECURITY: bound to `127.0.0.1` only, and refusing to start anywhere else, so
 * the tool cannot be exposed by a stray environment variable. It holds no
 * authentication because it exposes no authority: the browser can only ask the
 * agent to do what the agent already allows, and only with an action id the
 * agent itself offered. The app secret never leaves `chat_turn.ts`.
 *
 * One conversation is current at a time. This tool exists so one local human
 * can talk to the agent, and a single current conversation means there is no
 * session-identifier surface that could later be mistaken for an auth token.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { LOCAL_END_USER_ROLE, LOCAL_AGENT_TENANT_ID } from "./local_credentials.js";
import {
  ChatInputError,
  LocalChatConversation,
  type PublicChatView,
} from "./chat_conversation.js";
import type { ChatTurnGateway, ChatTurnInput } from "./chat_turn.js";
import { render_chat_page, render_client_script, type ChatPageContext } from "./chat_view.js";
import { next_end_user_wa_id } from "./meta_payload.js";

/** Largest accepted control request; a chat turn is a short line of text. */
export const MAX_CONTROL_BODY_BYTES = 8 * 1024;

/** Loopback-only listener plus the conversation the page is currently showing. */
export interface ChatServerOptions {
  gateway: ChatTurnGateway;
  webhook_path: string;
  reply_timeout_ms: number;
  host?: string;
  port?: number;
  now?: () => Date;
}

/** A running chat server. */
export interface ChatServerHandle {
  server: Server;
  base_url: string;
  stop(): Promise<void>;
  current_view(): PublicChatView;
}

/**
 * Content-Security-Policy for the chat page.
 *
 * `script-src 'self'` keeps the page on a same-origin script instead of
 * requiring inline execution, and `default-src 'none'` means a later change
 * cannot accidentally reach the network.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'unsafe-inline'",
  "connect-src 'self'",
  "img-src 'self'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Start the chat server on the loopback interface.
 *
 * @param options - Gateway, page context, and optional bind settings.
 * @returns A handle carrying the bound base URL.
 * @throws When a configured host is not loopback, or the port is taken.
 */
export async function start_chat_server(options: ChatServerOptions): Promise<ChatServerHandle> {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error("local-chat-loopback-only");
  }
  const now = options.now ?? (() => new Date());
  const context: ChatPageContext = {
    tenant_id: LOCAL_AGENT_TENANT_ID,
    role: LOCAL_END_USER_ROLE,
    webhook_path: options.webhook_path,
    reply_timeout_ms: options.reply_timeout_ms,
  };
  // Sequence starts at one so the first reset cannot mint the same ref as
  // the conversation the page was rendered with.
  const state = { sequence: 1, conversation: open_conversation(1, now) };
  const view = (): PublicChatView => state.conversation.to_public_view(context);
  const reset = (): PublicChatView => {
    state.sequence += 1;
    state.conversation = open_conversation(state.sequence, now);
    return view();
  };

  const server = createServer((request, response) => {
    void handle_request(request, response).catch(() => {
      respond(response, 500, JSON.stringify({ error: "internal_error" }), "application/json");
    });
  });

  async function handle_request(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? "GET";
    const path = (request.url ?? "/").split("?")[0] ?? "/";
    const status = await route(request, response, {
      method,
      path,
      context,
      view,
      reset,
      conversation: () => state.conversation,
      options,
    });
    log_request(method, path, status);
  }

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
    server.listen(options.port ?? 0, host);
  });

  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("local-chat-not-listening");
  return {
    server,
    base_url: `http://${host}:${address.port}`,
    stop: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    }),
    current_view: view,
  };
}

/** Everything the route table needs, gathered so the table stays flat. */
interface RouteDeps {
  method: string;
  path: string;
  context: ChatPageContext;
  view: () => PublicChatView;
  reset: () => PublicChatView;
  conversation: () => LocalChatConversation;
  options: ChatServerOptions;
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  deps: RouteDeps,
): Promise<number> {
  const { method, path } = deps;
  if (method === "GET" && path === "/healthz") {
    return respond(response, 200, "ok", "text/plain; charset=utf-8");
  }
  if (method === "GET" && path === "/chat/client.js") {
    return respond(response, 200, render_client_script(), "text/javascript; charset=utf-8");
  }
  if (method === "GET" && (path === "/" || path === "/chat")) {
    return respond(response, 200, render_chat_page(deps.view(), deps.context), "text/html; charset=utf-8");
  }
  if (method !== "POST") return respond_error(response, 404, "not_found");
  if (path === "/chat/sessions") return respond_json(response, 200, { view: deps.reset() });
  if (path === "/chat/redeliver") return redeliver(request, response, deps);
  if (path !== "/chat/turns" && path !== "/chat/signature-self-check") {
    return respond_error(response, 404, "not_found");
  }
  return submit_turn(request, response, deps, path === "/chat/signature-self-check");
}

/**
 * Replay the last signed turn verbatim, as a provider redelivery would.
 *
 * @param request - Control request; its body is drained and ignored.
 * @param response - Response to write.
 * @param deps - Route dependencies.
 * @returns 400 when nothing has been signed yet, otherwise the turn result.
 */
async function redeliver(
  request: IncomingMessage,
  response: ServerResponse,
  deps: RouteDeps,
): Promise<number> {
  try {
    await read_body(request);
  } catch {
    return respond_error(response, 400, "invalid_request");
  }
  try {
    const outcome = await deps.options.gateway.redeliver_last(deps.conversation());
    return respond_json(response, 200, {
      view: deps.view(),
      http_status: outcome.evidence.http_status,
      duplicate_count: outcome.evidence.duplicate_count,
      enqueued_count: outcome.evidence.enqueued_count,
    });
  } catch (error) {
    if (error instanceof ChatInputError) return respond_error(response, 400, input_error_code(error));
    return respond_error(response, 502, "agent_unavailable");
  }
}

async function submit_turn(
  request: IncomingMessage,
  response: ServerResponse,
  deps: RouteDeps,
  is_self_check: boolean,
): Promise<number> {
  let body: Record<string, unknown>;
  try {
    body = parse_control_body(await read_body(request));
  } catch {
    return respond_error(response, 400, "invalid_request");
  }
  const conversation = deps.conversation();
  try {
    const input = to_turn_input(body);
    const outcome = is_self_check
      ? await deps.options.gateway.run_signature_self_check(conversation, input)
      : await deps.options.gateway.submit(conversation, input);
    return respond_json(response, 200, {
      view: deps.view(),
      http_status: outcome.evidence.http_status,
      enqueued_count: outcome.evidence.enqueued_count,
      ...(outcome.reply_error === undefined ? {} : { reply_error: outcome.reply_error }),
    });
  } catch (error) {
    if (error instanceof ChatInputError) return respond_error(response, 400, input_error_code(error));
    return respond_error(response, 502, "agent_unavailable");
  }
}

/**
 * Read the browser's turn request into the gateway's input union.
 *
 * Values are type-checked rather than coerced, so an object or array can never
 * be stringified into a message body behind the caller's back.
 *
 * @param body - Parsed JSON object from the control request.
 * @returns A validated turn input.
 * @throws ChatInputError When the shape is not one of the two legal turns.
 */
function to_turn_input(body: Record<string, unknown>): ChatTurnInput {
  const kind = body["kind"];
  if (kind === "text") return { kind: "text", text: require_field(body, "text", "text-invalid") };
  if (kind === "button") {
    return { kind: "button", button_id: require_field(body, "button_id", "button-id-invalid") };
  }
  throw new ChatInputError("turn-kind-invalid");
}

function require_field(body: Record<string, unknown>, key: string, code: string): string {
  const value = body[key];
  if (typeof value !== "string") throw new ChatInputError(code);
  return value;
}

function parse_control_body(raw: string): Record<string, unknown> {
  if (raw === "") return {};
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ChatInputError("body-invalid");
  }
  return parsed as Record<string, unknown>;
}

async function read_body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.byteLength;
    if (size > MAX_CONTROL_BODY_BYTES) throw new ChatInputError("body-too-large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function respond(response: ServerResponse, status: number, body: string, content_type: string): number {
  const payload = Buffer.from(body, "utf8");
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  response.setHeader("Content-Type", content_type);
  response.setHeader("Content-Length", payload.byteLength);
  response.end(payload);
  return status;
}

function respond_json(response: ServerResponse, status: number, body: unknown): number {
  return respond(response, status, JSON.stringify(body), "application/json; charset=utf-8");
}

/**
 * Respond with a bounded error envelope.
 *
 * The code is a fixed lowercase token, never an exception message, so an
 * unexpected failure cannot relay internals to the browser.
 */
function respond_error(response: ServerResponse, status: number, code: string): number {
  return respond_json(response, status, { error: /^[a-z0-9_-]{1,64}$/u.test(code) ? code : "internal_error" });
}

function input_error_code(error: ChatInputError): string {
  return /^[a-z0-9-]{1,64}$/u.test(error.code) ? error.code : "invalid_request";
}

function log_request(method: string, path: string, status: number): void {
  // Structured, and deliberately narrow: no body, no credential, no sender.
  console.info(JSON.stringify({ event: "local_chat_request", method, path, status }));
}

function open_conversation(sequence: number, now: () => Date): LocalChatConversation {
  return new LocalChatConversation(`end-user-${sequence}`, next_end_user_wa_id(sequence), now);
}
