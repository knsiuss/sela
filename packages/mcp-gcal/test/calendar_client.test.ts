import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleCalendarClient } from "../src/calendar_client.js";

const CALENDAR_ID = "primary";
const ACCESS_TOKEN = "unit-access-token";

function make_client(fetch_mock: ReturnType<typeof vi.fn>): GoogleCalendarClient {
  return new GoogleCalendarClient({
    calendar_id: CALENDAR_ID,
    oauth_client: { get_access_token: vi.fn().mockResolvedValue(ACCESS_TOKEN) },
    fetch: fetch_mock,
    quota_user: "tenant-a",
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GoogleCalendarClient", () => {
  it("sends freebusy to the documented endpoint with bearer auth and quotaUser", async () => {
    const fetch_mock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ calendars: { primary: { busy: [] } } }), { status: 200 }),
    );
    const client = make_client(fetch_mock);

    await expect(
      client.freebusy_query({
        time_min: "2026-10-01T08:00:00Z",
        time_max: "2026-10-01T09:00:00Z",
        time_zone: "UTC",
      }),
    ).resolves.toEqual({ calendars: { primary: { busy: [] } } });

    const [url, init] = fetch_mock.mock.calls[0] ?? [];
    expect(url).toBe("https://www.googleapis.com/calendar/v3/freeBusy?quotaUser=tenant-a");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init?.body))).toEqual({
      timeMin: "2026-10-01T08:00:00Z",
      timeMax: "2026-10-01T09:00:00Z",
      timeZone: "UTC",
      items: [{ id: "primary" }],
    });
  });

  it("follows event list pageToken until all pages are read", async () => {
    const fetch_mock = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [{ id: "event-1" }], nextPageToken: "page-2" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [{ id: "event-2" }] }), { status: 200 }),
      );
    const client = make_client(fetch_mock);

    await expect(
      client.list_events({
        time_min: "2026-10-01T00:00:00Z",
        time_max: "2026-10-02T00:00:00Z",
        max_results: 1,
        single_events: true,
      }),
    ).resolves.toEqual({ items: [{ id: "event-1" }, { id: "event-2" }] });

    expect(fetch_mock).toHaveBeenCalledTimes(2);
    const first_url = new URL(String(fetch_mock.mock.calls[0]?.[0]));
    const second_url = new URL(String(fetch_mock.mock.calls[1]?.[0]));
    expect(first_url.pathname).toBe("/calendar/v3/calendars/primary/events");
    expect(first_url.searchParams.get("pageToken")).toBeNull();
    expect(first_url.searchParams.get("timeMin")).toBe("2026-10-01T00:00:00Z");
    expect(first_url.searchParams.get("maxResults")).toBe("1");
    expect(first_url.searchParams.get("singleEvents")).toBe("true");
    expect(second_url.searchParams.get("pageToken")).toBe("page-2");
  });

  it("translates network and timeout failures without exposing provider details", async () => {
    const network_client = make_client(vi.fn().mockRejectedValue(new Error("private network detail")));
    await expect(network_client.list_events()).rejects.toMatchObject({ code: "request_failed" });

    const timeout_error = new DOMException("private timeout detail", "TimeoutError");
    const timeout_client = make_client(vi.fn().mockRejectedValue(timeout_error));
    await expect(timeout_client.list_events()).rejects.toMatchObject({ code: "request_timeout" });
  });

  it("registers an HTTPS event watch channel", async () => {
    const fetch_mock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "channel-1", resourceId: "resource-1" }), { status: 200 }),
    );
    const client = make_client(fetch_mock);

    await client.watch_events({
      channel_id: "channel-1",
      address: "https://calendar.example.test/notify",
      token: "verification-token",
      expiration: 1_800_000_000_000,
    });

    const url = new URL(String(fetch_mock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/calendar/v3/calendars/primary/events/watch");
    expect(fetch_mock.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(fetch_mock.mock.calls[0]?.[1]?.body))).toEqual({
      id: "channel-1",
      type: "web_hook",
      address: "https://calendar.example.test/notify",
      token: "verification-token",
      expiration: 1_800_000_000_000,
    });
  });

  it("uses the documented event paths and preserves upstream error metadata safely", async () => {
    const fetch_mock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "event-1" }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { status: "CONFLICT", message: "private customer data" } }), { status: 409 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = make_client(fetch_mock);

    await client.insert_event({ event: { id: "event-1", summary: "Booking" } });
    await expect(
      client.patch_event({ event_id: "event-1", event: { summary: "Updated" } }),
    ).rejects.toMatchObject({
      status: 409,
      code_upstream: "CONFLICT",
      code: "upstream_error",
    });

    const insert_url = new URL(String(fetch_mock.mock.calls[0]?.[0]));
    const patch_url = new URL(String(fetch_mock.mock.calls[1]?.[0]));
    expect(insert_url.pathname).toBe("/calendar/v3/calendars/primary/events");
    expect(fetch_mock.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(patch_url.pathname).toBe("/calendar/v3/calendars/primary/events/event-1");
    expect(fetch_mock.mock.calls[1]?.[1]?.method).toBe("PATCH");

    await client.delete_event({ event_id: "event-1", send_updates: "none" });
    const delete_url = new URL(String(fetch_mock.mock.calls[2]?.[0]));
    expect(delete_url.pathname).toBe("/calendar/v3/calendars/primary/events/event-1");
    expect(delete_url.searchParams.get("sendUpdates")).toBe("none");
    expect(fetch_mock.mock.calls[2]?.[1]?.method).toBe("DELETE");
  });
});
