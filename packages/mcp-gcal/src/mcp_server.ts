import { createInterface } from "node:readline";
import {
  GoogleCalendarError,
  type GoogleCalendarClient,
  type GoogleCalendarEvent,
  type GoogleFreebusyResponse,
} from "./calendar_client.js";
import { derive_event_id } from "./idempotency.js";

const JSON_RPC_VERSION = "2.0";
const MCP_PROTOCOL_VERSION = "2025-06-18";
const SERVER_NAME = "sela-google-calendar";
const SERVER_VERSION = "0.1.0";

/** Constructor inputs for the minimal stdio MCP server. */
export interface GoogleCalendarMcpServerOptions {
  client: GoogleCalendarClient;
  default_time_zone?: string;
}

/** A JSON-RPC request accepted by the server. */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

/** A JSON-RPC response emitted by the server. */
export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Minimal MCP server exposing Google Calendar booking operations over stdio. */
export class GoogleCalendarMcpServer {
  private readonly client: GoogleCalendarClient;
  private readonly default_time_zone: string | undefined;

  constructor(options: GoogleCalendarMcpServerOptions) {
    if (options.client === undefined) {
      throw new Error("Google Calendar client is required");
    }
    this.client = options.client;
    this.default_time_zone = options.default_time_zone;
  }

  /**
   * Handle one decoded JSON-RPC request.
   *
   * Tool failures are returned as MCP `isError` results so a bad request does
   * not terminate the long-lived stdio process. Protocol and parse failures
   * retain JSON-RPC error semantics.
   */
  async handle_request(request: unknown): Promise<JsonRpcResponse | null> {
    const parsed_request = parse_request(request);
    if (parsed_request === null) {
      return rpc_error(null, -32600, "Invalid Request");
    }
    if (is_notification(parsed_request)) {
      if (parsed_request.method === "tools/call") await this.call_tool(parsed_request.params);
      return null;
    }
    const request_id = parsed_request.id ?? null;
    if (parsed_request.method === "initialize") {
      return rpc_result(request_id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    if (parsed_request.method === "tools/list") {
      return rpc_result(request_id, { tools: tool_definitions() });
    }
    if (parsed_request.method !== "tools/call") {
      return rpc_error(request_id, -32601, "Method not found");
    }
    return rpc_result(request_id, await this.call_tool(parsed_request.params));
  }

  /**
   * Read newline-delimited JSON-RPC messages until the input stream closes.
   * No credentials or request payloads are written to the output.
   */
  async start(
    input: NodeJS.ReadableStream = process.stdin,
    output: NodeJS.WritableStream = process.stdout,
  ): Promise<void> {
    const reader = createInterface({ input, crlfDelay: Infinity });
    for await (const line of reader) {
      if (line.trim() === "") continue;
      let decoded: unknown;
      try {
        decoded = JSON.parse(line);
      } catch {
        output.write(`${JSON.stringify(rpc_error(null, -32700, "Parse error"))}\n`);
        continue;
      }
      const response = await this.handle_request(decoded);
      if (response !== null) output.write(`${JSON.stringify(response)}\n`);
    }
  }

  private async call_tool(params: unknown): Promise<McpToolResult> {
    let arguments_value: unknown = {};
    try {
      const call = require_record(params, "tool call");
      const tool_name = require_string(call.name, "tool name");
      arguments_value = call.arguments ?? {};
      const arguments_record = require_record(arguments_value, "tool arguments");
      const result = await this.dispatch_tool(tool_name, arguments_record);
      return tool_success(result);
    } catch (error) {
      const idempotency_key = try_read_idempotency_key(arguments_value);
      return tool_failure(error, idempotency_key);
    }
  }

  private async dispatch_tool(
    tool_name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (tool_name === "list_availability") return this.list_availability(args);
    if (tool_name === "create_booking") return this.create_booking(args);
    if (tool_name === "reschedule_booking") return this.reschedule_booking(args);
    if (tool_name === "cancel_booking") return this.cancel_booking(args);
    throw new McpToolError("unknown_tool", "unknown tool");
  }

  private async list_availability(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const window_start_iso = read_timestamp(args, "window_start_iso");
    const window_end_iso = read_timestamp(args, "window_end_iso");
    const time_zone = read_optional_string(args, "time_zone") ?? this.default_time_zone;
    const response: GoogleFreebusyResponse = await this.client.freebusy_query({
      time_min: window_start_iso,
      time_max: window_end_iso,
      calendar_ids: [this.client.calendar_id],
      ...(time_zone === undefined ? {} : { time_zone }),
    });
    return { calendars: response.calendars };
  }

  private async create_booking(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const idempotency_key = read_idempotency_key(args);
    const start_iso = read_timestamp(args, "start_iso");
    const end_iso = read_timestamp(args, "end_iso");
    const summary = read_required_string(args, "summary");
    const description = read_optional_string(args, "description");
    const time_zone = read_optional_string(args, "time_zone") ?? this.default_time_zone;
    const booking_id = derive_event_id(this.client.calendar_id, idempotency_key);
    const event: GoogleCalendarEvent = {
      id: booking_id,
      summary,
      ...(description === undefined ? {} : { description }),
      start: to_event_time(start_iso, time_zone),
      end: to_event_time(end_iso, time_zone),
      extendedProperties: { private: { sela_idempotency_key: idempotency_key } },
    };
    await this.client.insert_event({ event });
    return booking_result(booking_id, idempotency_key, start_iso, end_iso, summary);
  }

  private async reschedule_booking(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const booking_id = read_required_string(args, "booking_id");
    const idempotency_key = read_idempotency_key(args);
    const start_iso = read_timestamp(args, "start_iso");
    const end_iso = read_timestamp(args, "end_iso");
    const summary = read_required_string(args, "summary");
    const description = read_optional_string(args, "description");
    const time_zone = read_optional_string(args, "time_zone") ?? this.default_time_zone;
    await this.client.patch_event({
      event_id: booking_id,
      event: {
        summary,
        ...(description === undefined ? {} : { description }),
        start: to_event_time(start_iso, time_zone),
        end: to_event_time(end_iso, time_zone),
        extendedProperties: { private: { sela_idempotency_key: idempotency_key } },
      },
    });
    return booking_result(booking_id, idempotency_key, start_iso, end_iso, summary);
  }

  private async cancel_booking(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const booking_id = read_required_string(args, "booking_id");
    const idempotency_key = read_idempotency_key(args);
    await this.client.delete_event({ event_id: booking_id });
    return { booking_id, idempotency_key, cancelled: true };
  }
}

interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

class McpToolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "McpToolError";
  }
}

function tool_definitions(): unknown[] {
  const string_property = (description: string) => ({ type: "string", description });
  return [
    {
      name: "list_availability",
      description: "Return Google Calendar busy blocks for an RFC3339 window.",
      inputSchema: {
        type: "object",
        properties: {
          window_start_iso: string_property("Inclusive window start in RFC3339 format."),
          window_end_iso: string_property("Exclusive window end in RFC3339 format."),
          time_zone: string_property("Optional IANA time zone for the response."),
        },
        required: ["window_start_iso", "window_end_iso"],
        additionalProperties: false,
      },
    },
    {
      name: "create_booking",
      description: "Create one calendar booking with an idempotent event id.",
      inputSchema: {
        type: "object",
        properties: {
          idempotency_key: string_property("Caller-stable key for safe retries."),
          start_iso: string_property("Booking start in RFC3339 format."),
          end_iso: string_property("Booking end in RFC3339 format."),
          summary: string_property("Calendar event title."),
          description: string_property("Optional calendar event body."),
          time_zone: string_property("Optional IANA time zone."),
        },
        required: ["idempotency_key", "start_iso", "end_iso", "summary"],
        additionalProperties: false,
      },
    },
    {
      name: "reschedule_booking",
      description: "Patch an existing booking to a new time and title.",
      inputSchema: {
        type: "object",
        properties: {
          booking_id: string_property("Existing Google event id."),
          idempotency_key: string_property("Caller-stable key for safe retries."),
          start_iso: string_property("New booking start in RFC3339 format."),
          end_iso: string_property("New booking end in RFC3339 format."),
          summary: string_property("Calendar event title."),
          description: string_property("Optional calendar event body."),
          time_zone: string_property("Optional IANA time zone."),
        },
        required: ["booking_id", "idempotency_key", "start_iso", "end_iso", "summary"],
        additionalProperties: false,
      },
    },
    {
      name: "cancel_booking",
      description: "Delete an existing calendar booking.",
      inputSchema: {
        type: "object",
        properties: {
          booking_id: string_property("Existing Google event id."),
          idempotency_key: string_property("Caller-stable key for safe retries."),
        },
        required: ["booking_id", "idempotency_key"],
        additionalProperties: false,
      },
    },
  ];
}

function parse_request(value: unknown): JsonRpcRequest | null {
  if (!is_record(value)) return null;
  if (value.jsonrpc !== JSON_RPC_VERSION || typeof value.method !== "string") return null;
  if (value.id !== undefined && !is_valid_id(value.id)) return null;
  return value as unknown as JsonRpcRequest;
}

function is_notification(request: JsonRpcRequest): boolean {
  return request.id === undefined;
}

function rpc_result(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: JSON_RPC_VERSION, id: id ?? null, result };
}

function rpc_error(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: JSON_RPC_VERSION, id, error: { code, message } };
}

function tool_success(result: Record<string, unknown>): McpToolResult {
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}

function tool_failure(error: unknown, idempotency_key: string | undefined): McpToolResult {
  const safe_error = safe_tool_error(error);
  const result: Record<string, unknown> = { error: safe_error };
  if (idempotency_key !== undefined) result.idempotency_key = idempotency_key;
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    isError: true,
  };
}

function safe_tool_error(error: unknown): Record<string, unknown> {
  if (error instanceof McpToolError) return { code: error.code, message: error.message };
  if (error instanceof GoogleCalendarError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(error.code_upstream === undefined ? {} : { code_upstream: error.code_upstream }),
    };
  }
  return { code: "invalid_input", message: "tool request was invalid" };
}

function booking_result(
  booking_id: string,
  idempotency_key: string,
  start_iso: string,
  end_iso: string,
  summary: string,
): Record<string, unknown> {
  return { booking_id, idempotency_key, start_iso, end_iso, summary, confirmed: true };
}

function to_event_time(timestamp: string, time_zone: string | undefined): { dateTime: string; timeZone?: string } {
  return { dateTime: timestamp, ...(time_zone === undefined ? {} : { timeZone: time_zone }) };
}

function read_idempotency_key(args: unknown): string {
  const record = require_record(args, "tool arguments");
  return read_required_string(record, "idempotency_key");
}

function try_read_idempotency_key(args: unknown): string | undefined {
  if (!is_record(args)) return undefined;
  const value = args.idempotency_key;
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function read_required_string(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") throw new McpToolError("invalid_input", `${key} is required`);
  return value;
}

function require_string(value: unknown, field_name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new McpToolError("invalid_input", `${field_name} must be a non-empty string`);
  }
  return value;
}

function read_optional_string(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") throw new McpToolError("invalid_input", `${key} must be a non-empty string`);
  return value;
}

function read_timestamp(args: Record<string, unknown>, key: string): string {
  const value = read_required_string(args, key);
  if (!Number.isFinite(Date.parse(value))) throw new McpToolError("invalid_input", `${key} must be RFC3339`);
  return value;
}

function require_record(value: unknown, field_name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new McpToolError("invalid_input", `${field_name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function is_valid_id(value: unknown): value is string | number | null {
  return value === null || typeof value === "string" || typeof value === "number";
}

/** Start a tenant-scoped Google Calendar MCP server on stdio. */
export async function start_google_calendar_mcp_server(
  options: GoogleCalendarMcpServerOptions,
): Promise<void> {
  await new GoogleCalendarMcpServer(options).start();
}
