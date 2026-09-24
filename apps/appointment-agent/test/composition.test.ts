import { describe, expect, it } from "vitest";
import { build_composition, CompositionConfigurationError } from "../src/composition.js";

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
    expect(composition.sender).toBeDefined();
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
