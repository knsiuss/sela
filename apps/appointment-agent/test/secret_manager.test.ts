import { describe, expect, it } from "vitest";
import {
  AuditedSecretManager,
  EnvSecretManager,
  InMemorySecretAccessSink,
  SecretManagerError,
  require_ref,
} from "../src/security/secret_manager.js";
import { NoopMetrics } from "../src/observability/metrics.js";

const ENV = {
  WHATSAPP_API_TOKEN: "test-token-whatsapp",
  WHATSAPP_APP_SECRET: "test-secret-app",
};

describe("secret manager", () => {
  it("resolves only allow-listed references", () => {
    const manager = new EnvSecretManager(ENV, new Set(["WHATSAPP_API_TOKEN"]));

    expect(manager.get_secret("WHATSAPP_API_TOKEN")).toBe("test-token-whatsapp");
    expect(() => manager.get_secret("WHATSAPP_APP_SECRET")).toThrow("secret-ref-invalid");
  });

  it("fails closed on missing values and malformed refs", () => {
    const manager = new EnvSecretManager({}, new Set(["WHATSAPP_API_TOKEN"]));

    expect(() => manager.get_secret("WHATSAPP_API_TOKEN")).toThrow("secret-not-configured");
    expect(() => manager.get_secret("not a ref")).toThrow("secret-ref-invalid");
    expect(() => manager.get_secret("")).toThrow("secret-ref-invalid");
    expect(() => require_ref("lowercase_ref")).toThrow("secret-ref-invalid");
  });

  it("never includes secret values in error messages", () => {
    const manager = new EnvSecretManager(ENV, new Set(["WHATSAPP_API_TOKEN"]));

    const attempt = (): string => manager.get_secret("WHATSAPP_APP_SECRET");
    expect(attempt).toThrow("secret-ref-invalid");
    expect(attempt).not.toThrow("test-token-whatsapp");
    expect(attempt).not.toThrow("test-secret-app");
  });

  it("audits hits and misses without recording values", () => {
    const sink = new InMemorySecretAccessSink();
    const manager = new AuditedSecretManager(
      new EnvSecretManager(ENV, new Set(["WHATSAPP_API_TOKEN"])),
      sink,
      new NoopMetrics(),
      () => new Date("2026-09-29T00:00:00.000Z"),
    );

    manager.get_secret("WHATSAPP_API_TOKEN");
    expect(() => manager.get_secret("WHATSAPP_APP_SECRET")).toThrow(SecretManagerError);

    expect(sink.events).toHaveLength(2);
    expect(sink.events[0]).toMatchObject({
      secret_ref: "WHATSAPP_API_TOKEN",
      operation: "read",
      result: "hit",
    });
    expect(sink.events[1]).toMatchObject({
      secret_ref: "WHATSAPP_APP_SECRET",
      operation: "read",
      result: "miss",
    });
    const serialized = JSON.stringify(sink.events);
    expect(serialized).not.toContain("test-token-whatsapp");
    expect(serialized).not.toContain("test-secret-app");
  });
});
