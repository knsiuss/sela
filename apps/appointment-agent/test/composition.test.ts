import { describe, expect, it, vi } from "vitest";
import { build_composition, CompositionConfigurationError } from "../src/composition.js";
import { PostgresRescheduleSessionStore } from "../src/reschedule/postgres_session_store.js";
import { InMemoryRescheduleSessionStore } from "../src/reschedule/session_store.js";
import { PostgresAppointmentRepository } from "../src/appointments/appointment_repository.js";
import { mark_multi_tenant_sender_registry } from "../src/outbound/sender_registry.js";
import type { OutboundSenderPort, OutboundSenderRegistry } from "../src/worker/loop.js";

describe("composition", () => {
  it("fails closed when neither Postgres nor explicit in-memory mode is configured", () => {
    expect(() => build_composition({ env: {} })).toThrow(CompositionConfigurationError);
  });

  it("builds the explicit in-memory fallback with a mapped channel", async () => {
    const composition = build_composition({
      env: {
        USE_IN_MEMORY: "true",
        WHATSAPP_PHONE_NUMBER_ID: "phone-local",
        TENANT_ID: "42",
        WORKER_POLL_INTERVAL_MS: "10",
        WORKER_MAX_ATTEMPTS: "2",
        WORKER_BATCH_SIZE: "1",
      },
    });

    expect(composition.reschedule_session_store).toBeInstanceOf(InMemoryRescheduleSessionStore);
    expect(composition.worker_tenant_id).toBe("42");
    await expect(composition.tenant_resolver.resolve("phone-local")).resolves.toBe("42");
    await expect(composition.tenant_resolver.resolve("phone-other")).resolves.toBeNull();
    const ciphertext = composition.recipient_cipher.encrypt("+12025550123");
    expect(composition.recipient_cipher.decrypt(ciphertext)).toBe("+12025550123");
    await composition.stop();
  });

  it("treats a blank transport setting as the explicit in-memory default", () => {
    const composition = build_composition({
      env: {
        USE_IN_MEMORY: "true",
        WHATSAPP_TRANSPORT: "",
        WHATSAPP_PHONE_NUMBER_ID: "phone-local",
      },
    });
    expect(composition.sender_registry).toBeDefined();
    return composition.stop();
  });

  it("does not allow the in-memory transport in a database-backed runtime", () => {
    expect(() =>
      build_composition({
        env: {
          DATABASE_URL: "postgres://test.invalid/app",
        CALENDAR_SLOTS_JSON: JSON.stringify([{
          id: "slot-1",
          start_iso: "2026-10-01T09:00:00.000Z",
          end_iso: "2026-10-01T09:30:00.000Z",
          resource_id: "7",
        }]),
          USE_IN_MEMORY: "true",
          WHATSAPP_TRANSPORT: "memory",
          WHATSAPP_RECIPIENT_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 5).toString("base64"),
        },
      }),
    ).toThrow("DATABASE_URL and USE_IN_MEMORY=true are mutually exclusive");
  });

  it("fails closed without a per-tenant sender mapping in database-backed mode", () => {
    expect(() =>
      build_composition({
        env: {
          DATABASE_URL: "postgres://test.invalid/app",
        CALENDAR_SLOTS_JSON: JSON.stringify([{
          id: "slot-1",
          start_iso: "2026-10-01T09:00:00.000Z",
          end_iso: "2026-10-01T09:30:00.000Z",
          resource_id: "7",
        }]),
          WHATSAPP_PHONE_NUMBER_ID: "phone-test",
          WHATSAPP_RECIPIENT_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 4).toString("base64"),
        },
      }),
    ).toThrow("tenant-sender-mapping-required");
  });

  it("selects the Postgres session store in database-backed mode", async () => {
    const composition = build_composition({
      env: {
        DATABASE_URL: "postgres://test.invalid/app",
        CALENDAR_SLOTS_JSON: JSON.stringify([{
          id: "slot-1",
          start_iso: "2026-10-01T09:00:00.000Z",
          end_iso: "2026-10-01T09:30:00.000Z",
          resource_id: "7",
        }]),
        WHATSAPP_TENANT_SENDER_REFS_JSON: JSON.stringify({
          "42": {
            phone_number_id_ref: "WHATSAPP_TENANT_42_PHONE_NUMBER_ID",
            access_token_ref: "WHATSAPP_TENANT_42_API_TOKEN",
          },
        }),
        WHATSAPP_TENANT_42_PHONE_NUMBER_ID: "phone-test",
        WHATSAPP_TENANT_42_API_TOKEN: "configured-test-token",
        WHATSAPP_RECIPIENT_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 4).toString("base64"),
      },
    });
    expect(composition.reschedule_session_store).toBeInstanceOf(PostgresRescheduleSessionStore);
    expect(composition.appointment_repository).toBeInstanceOf(PostgresAppointmentRepository);
    expect(composition.worker_tenant_id).toBeUndefined();
    await composition.stop();
  });

  it("accepts an explicitly declared multi-tenant sender registry", async () => {
    const sender_registry = mark_multi_tenant_sender_registry({
      send: vi.fn(async () => ({ status: "sent" })),
    });
    const composition = build_composition({
      env: {
        DATABASE_URL: "postgres://test.invalid/app",
        CALENDAR_SLOTS_JSON: JSON.stringify([{
          id: "slot-1",
          start_iso: "2026-10-01T09:00:00.000Z",
          end_iso: "2026-10-01T09:30:00.000Z",
          resource_id: "7",
        }]),
        WHATSAPP_RECIPIENT_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 4).toString("base64"),
      },
      sender_registry,
    });

    expect(composition.sender_registry).toBe(sender_registry);
    expect(composition.worker_tenant_id).toBeUndefined();
    await composition.stop();
  });

  it("rejects an unmarked global registry when no tenant binding is configured", () => {
    expect(() => build_composition({
      env: {
        DATABASE_URL: "postgres://test.invalid/app",
        CALENDAR_SLOTS_JSON: JSON.stringify([{
          id: "slot-1",
          start_iso: "2026-10-01T09:00:00.000Z",
          end_iso: "2026-10-01T09:30:00.000Z",
          resource_id: "7",
        }]),
        WHATSAPP_RECIPIENT_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 4).toString("base64"),
      },
      sender_registry: { send: async () => undefined },
    })).toThrow("multi-tenant-registry-required");
  });

  it("rejects conflicting legacy sender and registry injections", () => {
    expect(() =>
      build_composition({
        env: { USE_IN_MEMORY: "true" },
        sender: { send: async () => undefined },
        sender_registry: { send: async () => undefined },
      }),
    ).toThrow("sender-and-sender-registry-are-mutually-exclusive");
  });

  it("rejects a malformed injected sender registry", () => {
    const invalid_registry = { send: "not-a-function" } as unknown as OutboundSenderRegistry;

    expect(() =>
      build_composition({ env: { USE_IN_MEMORY: "true" }, sender_registry: invalid_registry }),
    ).toThrow("sender-registry-invalid");
  });

  it("rejects a malformed legacy per-sender injection", () => {
    const invalid_sender = { send: "not-a-function" } as unknown as OutboundSenderPort;

    expect(() =>
      build_composition({ env: { USE_IN_MEMORY: "true" }, sender: invalid_sender }),
    ).toThrow("sender-invalid");
  });

  it("fails closed when database-backed mode has no per-tenant sender mapping", () => {
    expect(() =>
      build_composition({
        env: {
          DATABASE_URL: "postgres://test.invalid/app",
        CALENDAR_SLOTS_JSON: JSON.stringify([{
          id: "slot-1",
          start_iso: "2026-10-01T09:00:00.000Z",
          end_iso: "2026-10-01T09:30:00.000Z",
          resource_id: "7",
        }]),
          WHATSAPP_PHONE_NUMBER_ID: "phone-test",
          WHATSAPP_API_TOKEN: "configured-test-token",
          WHATSAPP_RECIPIENT_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 4).toString("base64"),
        },
      }),
    ).toThrow("tenant-sender-mapping-required");
  });

  it("requires a bounded durable slot catalog in database-backed mode", () => {
    expect(() => build_composition({ env: { DATABASE_URL: "postgres://test.invalid/app" } }))
      .toThrow("CALENDAR_SLOTS_JSON-required");
    expect(() => build_composition({
      env: {
        DATABASE_URL: "postgres://test.invalid/app",
        CALENDAR_SLOTS_JSON: JSON.stringify([{
          id: "slot-without-resource",
          start_iso: "2026-10-01T09:00:00.000Z",
          end_iso: "2026-10-01T09:30:00.000Z",
        }]),
      },
    })).toThrow("CALENDAR_SLOTS_JSON-resource_id-required");
    expect(() => build_composition({
      env: { DATABASE_URL: "postgres://test.invalid/app" },
      slots: [],
    })).toThrow("CALENDAR_SLOTS_JSON-required");
  });

  it("requires a production recipient key whenever Postgres is configured", () => {
    expect(() =>
      build_composition({
        env: {
          DATABASE_URL: "postgres://test.invalid/app",
        CALENDAR_SLOTS_JSON: JSON.stringify([{
          id: "slot-1",
          start_iso: "2026-10-01T09:00:00.000Z",
          end_iso: "2026-10-01T09:30:00.000Z",
          resource_id: "7",
        }]),
        },
      }),
    ).toThrow("WHATSAPP_RECIPIENT_ENCRYPTION_KEY_BASE64-required");
  });
});
