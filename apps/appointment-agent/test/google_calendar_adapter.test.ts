import { describe, expect, it, vi } from "vitest";
import { GoogleCalendarError, type GoogleCalendarClient } from "@repo/mcp-gcal";
import { GoogleCalendarAdapter } from "../src/tools/google_calendar_adapter.js";
import { HoldExpiredError, SlotUnavailableError } from "../src/tools/calendar.js";

const TENANT_ID = "tenant-a";
const CALENDAR_ID = "primary";
const WINDOW_START = "2026-10-01T09:00:00Z";
const WINDOW_END = "2026-10-01T11:00:00Z";

interface MockClient {
  client: GoogleCalendarClient;
  freebusy_query: ReturnType<typeof vi.fn>;
  insert_event: ReturnType<typeof vi.fn>;
  patch_event: ReturnType<typeof vi.fn>;
  delete_event: ReturnType<typeof vi.fn>;
}

function make_client(busy: Array<{ start: string; end: string }> = []): MockClient {
  const freebusy_query = vi.fn().mockResolvedValue({
    calendars: { [CALENDAR_ID]: { busy } },
  });
  const insert_event = vi.fn().mockResolvedValue({ id: "event-12345" });
  const patch_event = vi.fn().mockResolvedValue({ id: "event-12345" });
  const delete_event = vi.fn().mockResolvedValue(undefined);
  const client = {
    calendar_id: CALENDAR_ID,
    freebusy_query,
    insert_event,
    patch_event,
    delete_event,
  } as unknown as GoogleCalendarClient;
  return { client, freebusy_query, insert_event, patch_event, delete_event };
}

function make_adapter(mock: MockClient): GoogleCalendarAdapter {
  return new GoogleCalendarAdapter({
    tenant_id: TENANT_ID,
    client: mock.client,
    working_hours: { start_time: "09:00", end_time: "11:00", days_of_week: [4] },
    service_duration_minutes: 30,
    clock: () => Date.parse("2026-10-01T08:00:00Z"),
  });
}

describe("GoogleCalendarAdapter", () => {
  it("derives working-hour slots from freebusy and filters overlapping busy blocks", async () => {
    const mock = make_client([{ start: "2026-10-01T09:30:00Z", end: "2026-10-01T10:30:00Z" }]);
    const adapter = make_adapter(mock);

    const slots = await adapter.list_slots(WINDOW_START, WINDOW_END);

    expect(slots.map((slot) => [slot.start_iso, slot.end_iso])).toEqual([
      ["2026-10-01T09:00:00.000Z", "2026-10-01T09:30:00.000Z"],
      ["2026-10-01T10:30:00.000Z", "2026-10-01T11:00:00.000Z"],
    ]);
    expect(mock.freebusy_query).toHaveBeenCalledWith({
      time_min: WINDOW_START,
      time_max: WINDOW_END,
      calendar_ids: [CALENDAR_ID],
    });
  });

  it("stores a hold marker with expiry and uses a deterministic event id", async () => {
    const mock = make_client();
    const adapter = make_adapter(mock);
    const [slot] = await adapter.list_slots(WINDOW_START, WINDOW_END);
    if (slot === undefined) throw new Error("test slot was not generated");

    const hold = await adapter.hold_slot(slot.id, 300, "hold-request-1");
    const insert = mock.insert_event.mock.calls[0]?.[0] as { event: { id: string; description: string } };

    expect(insert.event.id).toMatch(/^sela[0-9a-f]{64}$/);
    expect(insert.event.description).toContain(`sela_hold_${hold.hold_id} expires_at=2026-10-01T08:05:00.000Z`);
    expect(hold.slot_id).toBe(slot.id);

    await adapter.hold_slot(slot.id, 300);
    expect(mock.insert_event).toHaveBeenCalledOnce();
  });

  it("confirms idempotently without creating or patching a second event", async () => {
    const mock = make_client();
    const adapter = make_adapter(mock);
    const [slot] = await adapter.list_slots(WINDOW_START, WINDOW_END);
    if (slot === undefined) throw new Error("test slot was not generated");
    const hold = await adapter.hold_slot(slot.id, 300);

    await adapter.confirm_hold(hold.hold_id, "confirm-1");
    await adapter.confirm_hold(hold.hold_id, "confirm-1");

    expect(mock.insert_event).toHaveBeenCalledOnce();
    expect(mock.patch_event).toHaveBeenCalledOnce();
    expect(mock.patch_event.mock.calls[0]?.[0]).toMatchObject({
      event_id: expect.stringMatching(/^sela[0-9a-f]{64}$/),
      event: {
        summary: "Sela appointment",
        description: "Sela appointment hold",
      },
    });
  });

  it("shares one confirmation patch between concurrent retries", async () => {
    const mock = make_client();
    const adapter = make_adapter(mock);
    const [slot] = await adapter.list_slots(WINDOW_START, WINDOW_END);
    if (slot === undefined) throw new Error("test slot was not generated");
    const hold = await adapter.hold_slot(slot.id, 300);
    let resolve_patch: ((event: unknown) => void) | undefined;
    mock.patch_event.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolve_patch = resolve;
      }),
    );

    const first = adapter.confirm_hold(hold.hold_id, "concurrent-key");
    const second = adapter.confirm_hold(hold.hold_id, "concurrent-key");
    await Promise.resolve();
    expect(mock.patch_event).toHaveBeenCalledOnce();
    resolve_patch?.({});
    await Promise.all([first, second]);
    expect(mock.patch_event).toHaveBeenCalledOnce();
  });

  it("deletes the event when a booking is cancelled", async () => {
    const mock = make_client();
    const adapter = make_adapter(mock);
    const [slot] = await adapter.list_slots(WINDOW_START, WINDOW_END);
    if (slot === undefined) throw new Error("test slot was not generated");
    const hold = await adapter.hold_slot(slot.id, 300);
    await adapter.confirm_hold(hold.hold_id, "confirm-1");

    await adapter.cancel_booking(slot.id);

    expect(mock.delete_event).toHaveBeenCalledWith({ event_id: expect.stringMatching(/^sela[0-9a-f]{64}$/) });
  });

  it("maps Google 404/409 writes to the app domain errors", async () => {
    const hold_mock = make_client();
    hold_mock.insert_event.mockRejectedValueOnce(
      new GoogleCalendarError("upstream_error", "insert_event", "not found", 404, "NOT_FOUND"),
    );
    const hold_adapter = make_adapter(hold_mock);
    const [held_slot] = await hold_adapter.list_slots(WINDOW_START, WINDOW_END);
    if (held_slot === undefined) throw new Error("test slot was not generated");
    await expect(hold_adapter.hold_slot(held_slot.id, 300)).rejects.toBeInstanceOf(SlotUnavailableError);

    const confirm_mock = make_client();
    confirm_mock.patch_event.mockRejectedValueOnce(
      new GoogleCalendarError("upstream_error", "patch_event", "conflict", 409, "CONFLICT"),
    );
    const confirm_adapter = make_adapter(confirm_mock);
    const [confirm_slot] = await confirm_adapter.list_slots(WINDOW_START, WINDOW_END);
    if (confirm_slot === undefined) throw new Error("test slot was not generated");
    const hold = await confirm_adapter.hold_slot(confirm_slot.id, 300);
    await expect(confirm_adapter.confirm_hold(hold.hold_id, "conflict-key")).rejects.toBeInstanceOf(
      HoldExpiredError,
    );
  });
});
