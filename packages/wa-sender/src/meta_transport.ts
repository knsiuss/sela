import {
  build_meta_payload,
  OutboundMessageValidationError,
} from "./message_validation.js";
import { template_registry as default_template_registry, type TemplateRegistry } from "./template_registry.js";
import type { OutboundMessage, TransportResponse, WaSendErrorCode } from "./types.js";

/** Native fetch shape that can be replaced by a deterministic test double. */
export type WhatsAppFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** Minimal outbound transport boundary; implementations own provider I/O. */
export interface WhatsAppTransport {
  /**
   * Submit one normalized message.
   *
   * @param message - Message with the sender-derived idempotency key attached.
   * @returns Provider message identifier and optional safe billing metadata.
   */
  send(message: OutboundMessage): Promise<TransportResponse>;
}

/** Configuration for the direct Meta Graph transport. */
export interface MetaGraphTransportOptions {
  /** Graph API base URL, for example https://graph.facebook.com/v23.0. */
  graph_api_url?: string;
  /** Explicit test-only origins; production defaults to graph.facebook.com. */
  allowed_hosts?: readonly string[];
  /** Compatibility alias for callers that name the value a base URL. */
  graph_api_base_url?: string;
  /** Numeric Meta phone-number identifier. */
  phone_number_id: string;
  /** System-user or tenant access token supplied by the host secret provider. */
  access_token: string;
  /** Optional native fetch replacement. */
  fetch?: WhatsAppFetch;
  /** Bounded request timeout in milliseconds. */
  request_timeout_ms?: number;
  /** Registry used to fail closed when a template is sent directly. */
  template_registry?: TemplateRegistry;
}

/** Default bounded timeout for a Meta Graph request. */
export const DEFAULT_META_REQUEST_TIMEOUT_MS = 10_000;

/** Maximum supported Meta request timeout. */
export const MAX_META_REQUEST_TIMEOUT_MS = 120_000;

/** Production host allowlist for the bearer-token request. */
const DEFAULT_ALLOWED_HOSTS = ["graph.facebook.com"] as const;

const MIN_HTTP_STATUS = 100;
const MAX_HTTP_STATUS = 599;

/** Error containing only safe boundary metadata. */
export class WhatsAppSendError extends Error {
  /** Stable sender or transport failure category. */
  readonly code: WaSendErrorCode;
  /** Safe operation name. */
  readonly operation: string;
  /** HTTP status when a response was received. */
  readonly status: number | undefined;
  /** Sanitized provider code, never a provider message or body. */
  readonly upstream_code: string | undefined;
  /** Compatibility alias used by other package adapters. */
  readonly code_upstream: string | undefined;

  /**
   * Create a safe WhatsApp error.
   *
   * @param code - Stable failure category.
   * @param operation - Safe operation identifier.
   * @param message - Safe, caller-facing explanation.
   * @param status - Optional HTTP status.
   * @param upstream_code - Optional sanitized provider code.
   */
  constructor(
    code: WaSendErrorCode,
    operation: string,
    message: string,
    status?: number,
    upstream_code?: string,
  ) {
    super(message);
    this.name = "WhatsAppSendError";
    this.code = code;
    this.operation = operation;
    this.status = is_safe_http_status(status) ? status : undefined;
    this.upstream_code = upstream_code === undefined ? undefined : is_safe_upstream_code(upstream_code) ? upstream_code : undefined;
    this.code_upstream = this.upstream_code;
  }
}

/** Create a safe configuration error for transport or sender setup. */
export function create_configuration_error(message: string): WhatsAppSendError {
  return new WhatsAppSendError("configuration_error", "configuration", message);
}

/** Direct Meta Graph transport with one bounded native-fetch request. */
export class MetaGraphTransport implements WhatsAppTransport {
  private readonly endpoint: URL;
  private readonly access_token: string;
  private readonly fetch_implementation: WhatsAppFetch;
  private readonly request_timeout_ms: number;
  private readonly template_registry: TemplateRegistry;

  /**
   * Create a Meta Graph transport.
   *
   * @param options - Validated provider configuration; secrets remain caller-owned.
   * @throws WhatsAppSendError when configuration is unsafe or incomplete.
   */
  constructor(options: MetaGraphTransportOptions) {
    const base_url = options.graph_api_url ?? options.graph_api_base_url;
    this.endpoint = build_endpoint(
      base_url,
      options.phone_number_id,
      options.allowed_hosts ?? DEFAULT_ALLOWED_HOSTS,
    );
    this.access_token = require_secret(options.access_token);
    this.fetch_implementation = options.fetch ?? globalThis.fetch;
    if (typeof this.fetch_implementation !== "function") {
      throw create_configuration_error("Meta transport requires a fetch implementation");
    }
    this.request_timeout_ms = positive_integer(
      options.request_timeout_ms,
      DEFAULT_META_REQUEST_TIMEOUT_MS,
      MAX_META_REQUEST_TIMEOUT_MS,
    );
    this.template_registry = options.template_registry ?? default_template_registry;
  }

  /**
   * Send one normalized message to Meta without automatic retry.
   *
   * @param message - Validated message with an idempotency key.
   * @returns Parsed outbound WAMID.
   * @throws WhatsAppSendError for unsafe configuration, timeout, upstream, or response failures.
   */
  async send(message: OutboundMessage): Promise<TransportResponse> {
    const payload = this.build_payload(message);
    const response = await this.request(payload);
    return this.read_response(response);
  }

  private build_payload(message: OutboundMessage): Record<string, unknown> {
    try {
      return build_meta_payload(message, this.template_registry);
    } catch (error) {
      if (error instanceof OutboundMessageValidationError) {
        throw new WhatsAppSendError(error.code, "validate", "Outbound message was invalid");
      }
      throw new WhatsAppSendError("invalid_message", "validate", "Outbound message was invalid");
    }
  }

  private async request(payload: Record<string, unknown>): Promise<Response> {
    const headers = new Headers({
      Accept: "application/json",
      Authorization: `Bearer ${this.access_token}`,
      "Content-Type": "application/json",
    });
    try {
      return await this.fetch_implementation(this.endpoint.toString(), {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.request_timeout_ms),
        redirect: "error",
      });
    } catch (error) {
      if (is_timeout_error(error)) {
        throw new WhatsAppSendError("request_timeout", "send", "Meta Graph request timed out");
      }
      throw new WhatsAppSendError("request_failed", "send", "Meta Graph request failed before a response");
    }
  }

  private async read_response(response: Response): Promise<TransportResponse> {
    if (!response.ok) {
      const upstream_code = await read_safe_upstream_code(response);
      throw new WhatsAppSendError(
        "upstream_error",
        "send",
        `Meta Graph request failed with status ${response.status}`,
        response.status,
        upstream_code,
      );
    }
    let response_payload: unknown;
    try {
      response_payload = await response.json();
    } catch {
      throw new WhatsAppSendError("invalid_response", "send", "Meta Graph response was not JSON");
    }
    return { wamid: parse_outbound_wamid(response_payload) };
  }
}

/** Parse the first outbound WAMID from a Meta messages response. */
export function parse_outbound_wamid(payload: unknown): string {
  if (!is_record(payload) || !Array.isArray(payload.messages) || payload.messages.length === 0) {
    throw new WhatsAppSendError("invalid_response", "parse_response", "Meta Graph response did not contain a message");
  }
  const first = payload.messages[0];
  if (!is_record(first)) {
    throw new WhatsAppSendError("invalid_response", "parse_response", "Meta Graph response message was invalid");
  }
  return require_wamid(first.id);
}

async function read_safe_upstream_code(response: Response): Promise<string | undefined> {
  try {
    const payload: unknown = await response.json();
    if (!is_record(payload) || !is_record(payload.error)) return undefined;
    for (const field of ["code", "error_subcode"]) {
      const value = payload.error[field];
      if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
      if (typeof value === "string" && /^\d{1,10}$/u.test(value)) return value;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function build_endpoint(
  base_url: string | undefined,
  phone_number_id: string,
  allowed_hosts: readonly string[],
): URL {
  if (
    typeof base_url !== "string" ||
    base_url.trim() === "" ||
    /[\u0000-\u001f\u007f]/u.test(base_url)
  ) {
    throw create_configuration_error("Meta Graph API URL is required");
  }
  let url: URL;
  try {
    url = new URL(base_url);
  } catch {
    throw create_configuration_error("Meta Graph API URL is invalid");
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw create_configuration_error("Meta Graph API URL must be safe HTTPS without credentials or query data");
  }
  const normalized_hosts = allowed_hosts.map((host) => host.trim().toLowerCase()).filter((host) => host !== "");
  if (normalized_hosts.length === 0 || !normalized_hosts.includes(url.hostname.toLowerCase())) {
    throw create_configuration_error("Meta Graph API host is not allowlisted");
  }
  const phone_id = require_phone_number_id(phone_number_id);
  const base_path = url.pathname.replace(/\/+$/u, "");
  url.pathname = `${base_path}/${encodeURIComponent(phone_id)}/messages`;
  return url;
}

function require_secret(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 8_192 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw create_configuration_error("access_token is invalid");
  }
  return value;
}

function require_phone_number_id(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
    throw create_configuration_error("phone_number_id is invalid");
  }
  return value;
}

function positive_integer(value: number | undefined, default_value: number, maximum: number): number {
  if (value === undefined) return default_value;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw create_configuration_error("request_timeout_ms is invalid");
  }
  return value;
}

function require_wamid(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new WhatsAppSendError("invalid_response", "parse_response", "WhatsApp message identifier was invalid");
  }
  return value;
}

function is_safe_upstream_code(value: string): boolean {
  return value.length > 0 && value.length <= 128 && /^[A-Za-z0-9_.:-]+$/u.test(value);
}

function is_safe_http_status(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value >= MIN_HTTP_STATUS && value <= MAX_HTTP_STATUS;
}

function is_timeout_error(error: unknown): boolean {
  return is_record(error) && (error.name === "AbortError" || error.name === "TimeoutError");
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
