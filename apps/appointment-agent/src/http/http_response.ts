import type { ServerResponse } from "node:http";
import { DedupeStoreError } from "../ingress/dedupe.js";
import {
  MissingChallengeError,
  MissingVerifyTokenError,
  VerifyTokenMismatchError,
} from "../ingress/verify.js";
import {
  InvalidWebhookPayloadError,
  WebhookQueueError,
  WebhookSignatureError,
} from "../webhook_handler.js";
import {
  RequestBodyTooLargeError,
  RequestReadError,
} from "./request_body.js";

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const TEXT_CONTENT_TYPE = "text/plain; charset=utf-8";

/** HTTP status codes used by the webhook boundary. */
export const HTTP_STATUS = {
  OK: 200,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  PAYLOAD_TOO_LARGE: 413,
  INTERNAL_SERVER_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
} as const;

export interface HttpResponse {
  status: number;
  body: Buffer | string;
  content_type: string;
  allow?: string;
}

/** Signals that processing exceeded the bounded HTTP response budget. */
export class RequestDeadlineError extends Error {
  constructor() {
    super("webhook-request-deadline-exceeded");
    this.name = "RequestDeadlineError";
  }
}

/** Signals a known route was addressed with an unsupported method. */
export class MethodNotAllowedError extends Error {
  constructor(readonly allow: string) {
    super("method-not-allowed");
    this.name = "MethodNotAllowedError";
  }
}

/** Build a JSON response with a fixed content type. */
export function json_response(status: number, value: unknown): HttpResponse {
  return { status, body: JSON.stringify(value), content_type: JSON_CONTENT_TYPE };
}

/** Build a plain-text response with a fixed content type. */
export function text_response(status: number, value: string): HttpResponse {
  return { status, body: value, content_type: TEXT_CONTENT_TYPE };
}

/** Translate a typed ingress error into a safe client response. */
export function error_response(error: unknown): HttpResponse {
  if (error instanceof RequestBodyTooLargeError) {
    return json_response(HTTP_STATUS.PAYLOAD_TOO_LARGE, { error: "payload_too_large" });
  }
  if (
    error instanceof WebhookSignatureError ||
    error instanceof MissingVerifyTokenError ||
    error instanceof MissingChallengeError ||
    error instanceof VerifyTokenMismatchError
  ) {
    return json_response(HTTP_STATUS.UNAUTHORIZED, { error: "unauthorized" });
  }
  if (error instanceof InvalidWebhookPayloadError || error instanceof RequestReadError) {
    return json_response(HTTP_STATUS.BAD_REQUEST, { error: "invalid_webhook_payload" });
  }
  if (error instanceof WebhookQueueError || error instanceof DedupeStoreError) {
    return json_response(HTTP_STATUS.SERVICE_UNAVAILABLE, { error: "webhook_temporarily_unavailable" });
  }
  if (error instanceof RequestDeadlineError) {
    return json_response(HTTP_STATUS.SERVICE_UNAVAILABLE, { error: "webhook_temporarily_unavailable" });
  }
  if (error instanceof MethodNotAllowedError) {
    return { ...json_response(HTTP_STATUS.METHOD_NOT_ALLOWED, { error: "method_not_allowed" }), allow: error.allow };
  }
  return json_response(HTTP_STATUS.INTERNAL_SERVER_ERROR, { error: "internal_server_error" });
}

/** Write one response with cache prevention and a known content length. */
export function send_response(response: ServerResponse, result: HttpResponse): void {
  if (response.headersSent || response.writableEnded) return;
  response.statusCode = result.status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Type", result.content_type);
  if (result.allow !== undefined) response.setHeader("Allow", result.allow);
  const body = Buffer.isBuffer(result.body) ? result.body : Buffer.from(result.body, "utf8");
  response.setHeader("Content-Length", body.byteLength);
  response.end(body);
}
