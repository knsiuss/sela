import { describe, expect, it, vi } from "vitest";
import {
  derive_idempotency_key,
  fingerprint_outbound_message,
  IdempotencyCoordinator,
  IdempotencyError,
  InMemoryIdempotencyStore,
  is_valid_idempotency_key,
  type OutboundMessage,
} from "../src/index.js";

function make_message(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    to: "+12025550100",
    type: "text",
    text: { body: "Hello" },
    ...overrides,
  };
}

describe("idempotency", () => {
  it("derives stable keys from explicit identity and canonical content", () => {
    const identity_message = make_message({ inbound_wamid: "wamid-1", turn_id: "turn-1" });
    expect(derive_idempotency_key(identity_message)).toBe(derive_idempotency_key(identity_message));
    expect(derive_idempotency_key(identity_message)).toMatch(/^wa:[a-f0-9]{64}$/u);

    const max_length_identity = make_message({ inbound_wamid: "w".repeat(128), turn_id: "0" });
    const max_length_key = derive_idempotency_key(max_length_identity);
    expect(max_length_key).toMatch(/^wa:[a-f0-9]{64}$/u);
    expect(is_valid_idempotency_key(max_length_key)).toBe(true);

    const first = make_message();
    const reordered = make_message({ idempotency_key: undefined });
    expect(fingerprint_outbound_message(first)).toBe(fingerprint_outbound_message(reordered));
    expect(derive_idempotency_key(first)).toBe(derive_idempotency_key(reordered));
    expect(derive_idempotency_key(make_message({ inbound_wamid: "wamid-only" }))).not.toBe(
      derive_idempotency_key(make_message({ inbound_wamid: "wamid-only", text: { body: "Other" } })),
    );

    expect(derive_idempotency_key(make_message({ idempotency_key: "caller-key" }))).toBe("caller-key");
  });

  it("rejects malformed explicit keys and partial inbound identity", () => {
    expect(() => derive_idempotency_key(make_message({ idempotency_key: "has space" }))).toThrow(IdempotencyError);
    expect(() => derive_idempotency_key(make_message({ turn_id: "turn-only" }))).toThrow(IdempotencyError);
    expect(is_valid_idempotency_key("safe-key_1:2")).toBe(true);
    expect(is_valid_idempotency_key("unsafe/key")).toBe(false);
  });

  it("suppresses concurrent identical operations and returns the first result", async () => {
    const coordinator = new IdempotencyCoordinator<string>();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = vi.fn(async () => {
      await gate;
      return "wamid-1";
    });

    const first = coordinator.execute("operation-1", fingerprint_outbound_message(make_message()), operation);
    const second = coordinator.execute("operation-1", fingerprint_outbound_message(make_message()), operation);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual(["wamid-1", "wamid-1"]);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("rejects a conflicting fingerprint and permits a retry after operation failure", async () => {
    const coordinator = new IdempotencyCoordinator<string>();
    const fingerprint = fingerprint_outbound_message(make_message());
    const operation = vi.fn().mockRejectedValueOnce(new Error("provider detail")).mockResolvedValueOnce("ok");
    await expect(coordinator.execute("operation-2", fingerprint, operation)).rejects.toThrow("provider detail");
    await expect(coordinator.execute("operation-2", fingerprint, operation)).resolves.toBe("ok");
    await expect(
      coordinator.execute("operation-2", fingerprint_outbound_message(make_message({ text: { body: "Other" } })), operation),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("expires bounded in-memory records", () => {
    let now_ms = 1_000;
    const store = new InMemoryIdempotencyStore<string>({ clock: () => now_ms, ttl_ms: 10, max_entries: 1 });
    const entry = {
      key: "expired-1",
      fingerprint: fingerprint_outbound_message(make_message()),
      result: "done",
      expires_at_ms: 1_010,
    };
    store.set(entry);
    expect(store.get("expired-1")?.result).toBe("done");
    now_ms = 1_010;
    expect(store.get("expired-1")).toBeUndefined();
  });

  it("fails closed when the configured store is unavailable", async () => {
    const coordinator = new IdempotencyCoordinator<string>({
      store: {
        get: vi.fn().mockRejectedValue(new Error("private store detail")),
        set: vi.fn(),
      },
    });
    await expect(
      coordinator.execute("store-down", fingerprint_outbound_message(make_message()), async () => "never"),
    ).rejects.toMatchObject({ code: "store_unavailable" });
  });

  it("supports the identity-only derivation overload", () => {
    expect(derive_idempotency_key("wamid-1", "turn-1")).toBe(
      derive_idempotency_key(make_message({ inbound_wamid: "wamid-1", turn_id: "turn-1" })),
    );
  });
});
