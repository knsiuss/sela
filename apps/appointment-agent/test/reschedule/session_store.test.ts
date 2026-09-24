import { describe, expect, it, vi } from "vitest";
import type { SqlClient } from "../../src/persistence/sql_client.js";
import { PostgresRescheduleSessionStore } from "../../src/reschedule/postgres_session_store.js";
import {
  InMemoryRescheduleSessionStore,
  RescheduleSessionStoreError,
} from "../../src/reschedule/session_store.js";
import {
  RescheduleSessionValidationError,
  parse_reschedule_session_state,
  type RescheduleSessionState,
} from "../../src/reschedule/session_model.js";

const NOW_ISO = "2026-09-24T08:00:00.000Z";
const FUTURE_ISO = "2026-09-25T08:00:00.000Z";
const SLOT = {
  id: "slot-1",
  start_iso: "2026-09-26T08:00:00.000Z",
  end_iso: "2026-09-26T08:30:00.000Z",
  staff: "provider-1",
};

function state(overrides: Partial<RescheduleSessionState> = {}): RescheduleSessionState {
  return {
    phase: "offered",
    candidate_slots: [SLOT],
    chosen_slot_id: null,
    hold_id: null,
    hold_expires_at_iso: null,
    offer_generation: 1,
    last_wamid: "wamid-1",
    expires_at_iso: FUTURE_ISO,
    ...overrides,
  };
}

function database_row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenant_id: 42,
    conversation_id: "conversation-1",
    phase: "offered",
    candidate_slots: [SLOT],
    chosen_slot_id: null,
    hold_id: null,
    hold_expires_at_iso: null,
    offer_generation: 1,
    last_wamid: "wamid-1",
    version: 1,
    expires_at: FUTURE_ISO,
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    ...overrides,
  };
}

describe("reschedule session store", () => {
  it("isolates tenants and conversations and returns defensive copies", async () => {
    const store = new InMemoryRescheduleSessionStore({ clock: () => new Date(NOW_ISO) });
    await store.commit({ tenant_id: "42", conversation_id: "conversation-1" }, state(), null);
    await store.commit({ tenant_id: "43", conversation_id: "conversation-1" }, state(), null);
    await store.commit({ tenant_id: "42", conversation_id: "conversation-2" }, state(), null);

    const loaded = await store.load({ tenant_id: "42", conversation_id: "conversation-1" });
    if (loaded?.candidate_slots[0] !== undefined) loaded.candidate_slots[0].id = "mutated";
    expect((await store.load({ tenant_id: "42", conversation_id: "conversation-1" }))?.candidate_slots[0]?.id)
      .toBe(SLOT.id);
    await expect(store.load({ tenant_id: "44", conversation_id: "conversation-1" })).resolves.toBeNull();
    await expect(store.all()).resolves.toHaveLength(3);
  });

  it("uses compare-and-swap versions and never overwrites a stale writer", async () => {
    const store = new InMemoryRescheduleSessionStore({ clock: () => new Date(NOW_ISO) });
    const scope = { tenant_id: "42", conversation_id: "conversation-1" };
    const created = await store.commit(scope, state(), null);
    expect(created?.version).toBe(1);

    const updated = await store.commit(
      scope,
      state({ offer_generation: 2, last_wamid: "wamid-2" }),
      created!.version,
    );
    expect(updated).toMatchObject({ version: 2, offer_generation: 2, last_wamid: "wamid-2" });
    await expect(
      store.commit(scope, state({ offer_generation: 3 }), created!.version),
    ).resolves.toBeNull();
    expect((await store.load(scope))?.offer_generation).toBe(2);
  });

  it("replaces expired session rows and rejects a state that is already expired", async () => {
    let now = new Date(NOW_ISO);
    const store = new InMemoryRescheduleSessionStore({ clock: () => now });
    const scope = { tenant_id: "42", conversation_id: "conversation-1" };
    await store.commit(scope, state(), null);
    now = new Date(FUTURE_ISO);

    const replacement = await store.commit(
      scope,
      state({ expires_at_iso: "2026-09-26T08:00:00.000Z", last_wamid: "wamid-2" }),
      null,
    );
    expect(replacement).toMatchObject({ version: 1, last_wamid: "wamid-2" });
    await expect(store.load(scope)).resolves.toMatchObject({ last_wamid: "wamid-2" });
    await expect(
      store.commit(scope, state({ expires_at_iso: NOW_ISO }), null),
    ).rejects.toBeInstanceOf(RescheduleSessionStoreError);
  });

  it("rejects unknown slot properties so raw message or phone fields cannot persist", () => {
    const unsafe = state({
      candidate_slots: [{ ...SLOT, phone: "+15551234567" } as typeof SLOT],
    });
    expect(() => parse_reschedule_session_state(unsafe)).toThrow(RescheduleSessionValidationError);
    expect(() => parse_reschedule_session_state(unsafe)).not.toThrow(/15551234567/);
  });

  it("uses parameterized Postgres reads and writes without PII columns", async () => {
    const query = vi.fn(async (sql: string, _values?: readonly unknown[]) => {
      if (sql.includes("INSERT INTO reschedule_sessions")) return { rows: [database_row()], rowCount: 1 };
      if (sql.includes("UPDATE reschedule_sessions")) {
        return { rows: [database_row({ version: 2, last_wamid: "wamid-2" })], rowCount: 1 };
      }
      return { rows: [database_row()], rowCount: 1 };
    });
    const store = new PostgresRescheduleSessionStore({ query } satisfies SqlClient);
    const scope = { tenant_id: "42", conversation_id: "conversation-1" };

    await expect(store.load(scope)).resolves.toMatchObject({ tenant_id: "42", version: 1 });
    await expect(store.commit(scope, state(), null)).resolves.toMatchObject({ version: 1 });
    await expect(
      store.commit(scope, state({ offer_generation: 2, last_wamid: "wamid-2" }), 1),
    ).resolves.toMatchObject({ version: 2 });

    expect(query.mock.calls[0]?.[1]).toEqual(["42", "conversation-1"]);
    expect(query.mock.calls[1]?.[0]).toContain("WHERE reschedule_sessions.expires_at <= now()");
    expect(query.mock.calls[1]?.[1]).toEqual([
      "42",
      "conversation-1",
      "offered",
      JSON.stringify([SLOT]),
      null,
      null,
      null,
      1,
      "wamid-1",
      FUTURE_ISO,
    ]);
    expect(query.mock.calls[2]?.[1]?.[10]).toBe(1);
    for (const [sql, values] of query.mock.calls) {
      expect(sql).not.toContain("message_text");
      expect(sql).not.toContain("phone");
      expect(JSON.stringify(values)).not.toContain("+15551234567");
    }
  });

  it("rejects an expired Postgres session state before issuing a write", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const store = new PostgresRescheduleSessionStore(
      { query } satisfies SqlClient,
      { clock: () => new Date(FUTURE_ISO) },
    );
    await expect(
      store.commit({ tenant_id: "42", conversation_id: "conversation-1" }, state(), null),
    ).rejects.toBeInstanceOf(RescheduleSessionStoreError);
    expect(query).not.toHaveBeenCalled();
  });

  it("returns null for a Postgres version conflict and wraps driver failures safely", async () => {
    const conflict_query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const conflict_store = new PostgresRescheduleSessionStore({ query: conflict_query } satisfies SqlClient);
    await expect(
      conflict_store.commit({ tenant_id: "42", conversation_id: "conversation-1" }, state(), 9),
    ).resolves.toBeNull();

    const failure_query = vi.fn(async () => {
      throw new Error("password=secret internal SQL");
    });
    const failure_store = new PostgresRescheduleSessionStore({ query: failure_query } satisfies SqlClient);
    const error = await failure_store
      .load({ tenant_id: "42", conversation_id: "conversation-1" })
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(RescheduleSessionStoreError);
    expect(String(error)).not.toMatch(/secret|internal SQL/);
  });
});
