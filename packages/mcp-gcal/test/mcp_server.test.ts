import { describe, expect, it, vi } from "vitest";
import { GoogleCalendarClient, GoogleCalendarError } from "../src/calendar_client.js";
import { GoogleCalendarMcpServer } from "../src/mcp_server.js";

function make_server(fetch_mock: ReturnType<typeof vi.fn>): GoogleCalendarMcpServer {
  const client = new GoogleCalendarClient({
    calendar_id: "primary",
    oauth_client: { get_access_token: vi.fn().mockResolvedValue("unit-access-token") },
    fetch: fetch_mock,
  });
  return new GoogleCalendarMcpServer({ client });
}

describe("GoogleCalendarMcpServer", () => {
  it("implements initialize and lists the four connector tools", async () => {
    const server = make_server(vi.fn());

    const initialize = await server.handle_request({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
    });
    const tools = await server.handle_request({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });

    expect(initialize?.result).toMatchObject({
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
    });
    const tool_result = (tools?.result as { tools: Array<{ name: string }> }).tools;
    expect(tool_result.map((tool) => tool.name)).toEqual([
      "list_availability",
      "create_booking",
      "reschedule_booking",
      "cancel_booking",
    ]);
  });

  it("returns booking idempotency keys in tool results", async () => {
    const fetch_mock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "sela-created-event" }), { status: 200 }),
    );
    const server = make_server(fetch_mock);

    const response = await server.handle_request({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "create_booking",
        arguments: {
          idempotency_key: "request-1",
          start_iso: "2026-10-01T08:00:00Z",
          end_iso: "2026-10-01T08:30:00Z",
          summary: "Appointment",
        },
      },
    });

    const result = (response?.result as { content: Array<{ text: string }> }).content[0]?.text;
    expect(result).toContain('"idempotency_key":"request-1"');
    const insert_body = JSON.parse(String(fetch_mock.mock.calls[0]?.[1]?.body));
    expect(insert_body.id).toMatch(/^sela[0-9a-f]{64}$/);
  });

  it("returns upstream failures as isError tool results without crashing", async () => {
    const fetch_mock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { status: "NOT_FOUND", message: "private" } }), { status: 404 }),
    );
    const server = make_server(fetch_mock);

    const response = await server.handle_request({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "cancel_booking",
        arguments: { booking_id: "event-12345", idempotency_key: "cancel-1" },
      },
    });
    const tool_result = response?.result as { isError?: boolean; content: Array<{ text: string }> };

    expect(tool_result.isError).toBe(true);
    expect(tool_result.content[0]?.text).toContain('"idempotency_key":"cancel-1"');
    expect(tool_result.content[0]?.text).toContain('"status":404');
  });

  it("keeps invalid tool calls inside the JSON-RPC result", async () => {
    const server = make_server(vi.fn());
    const response = await server.handle_request({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "create_booking", arguments: { idempotency_key: "key" } },
    });
    const result = response?.result as { isError?: boolean };
    expect(result.isError).toBe(true);
  });
});
