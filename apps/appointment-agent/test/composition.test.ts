import { describe, expect, it, vi } from "vitest";
import { build_composition, CompositionConfigurationError } from "../src/composition.js";
import { PostgresRescheduleSessionStore } from "../src/reschedule/postgres_session_store.js";
import { InMemoryRescheduleSessionStore } from "../src/reschedule/session_store.js";
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
          USE_IN_MEMORY: "true",
          WHATSAPP_TRANSPORT: "memory",
          WHATSAPP_RECIPIENT_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 5).toString("base64"),
        },
      }),
    ).toThrow("DATABASE_URL and USE_IN_MEMORY=true are mutually exclusive");
  });

  it("fails closed when a database-backed runtime has no Meta sender credentials", () => {
    expect(() =>
      build_composition({
        env: {
          DATABASE_URL: "postgres://test.invalid/app",
          WHATSAPP_PHONE_NUMBER_ID: "phone-test",
          WHATSAPP_RECIPIENT_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 4).toString("base64"),
        },
      }),
    ).toThrow("WHATSAPP_API_TOKEN-required");
  });

  it("selects the Postgres session store in database-backed mode", async () => {
    const composition = build_composition({
      env: {
        DATABASE_URL: "postgres://test.invalid/app",
        WHATSAPP_PHONE_NUMBER_ID: "phone-test",
        WHATSAPP_API_TOKEN: "configured-test-token",
        TENANT_ID: "42",
        WHATSAPP_RECIPIENT_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 4).toString("base64"),
      },
    });
    expect(composition.reschedule_session_store).toBeInstanceOf(PostgresRescheduleSessionStore);
    await composition.stop();
  });

  it("accepts an injected sender registry for database-backed deployment wiring", async () => {
    const sender_registry = { send: vi.fn(async () => ({ status: "sent" })) };
    const composition = build_composition({
      env: {
        DATABASE_URL: "postgres://test.invalid/app",
        WHATSAPP_RECIPIENT_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 4).toString("base64"),
      },
      sender_registry,
    });

    expect(composition.sender_registry).toBe(sender_registry);
    await composition.stop();
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

  it("fails closed when database-backed runtime credentials have no tenant binding", () => {
    expect(() =>
      build_composition({
        env: {
          DATABASE_URL: "postgres://test.invalid/app",
          WHATSAPP_PHONE_NUMBER_ID: "phone-test",
          WHATSAPP_API_TOKEN: "configured-test-token",
          WHATSAPP_RECIPIENT_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 4).toString("base64"),
        },
      }),
    ).toThrow("TENANT_ID-required");
  });

  it("requires a production recipient key whenever Postgres is configured", () => {
    expect(() =>
      build_composition({
        env: {
          DATABASE_URL: "postgres://test.invalid/app",
        },
      }),
    ).toThrow("WHATSAPP_RECIPIENT_ENCRYPTION_KEY_BASE64-required");
  });
});
