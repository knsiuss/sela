import { describe, expect, it, vi } from "vitest";
import {
  InMemoryTenantResolver,
  SqlTenantResolver,
  TenantResolverError,
} from "../src/ingress/tenant_resolver.js";
import type { SqlClient } from "../src/persistence/sql_client.js";

describe("tenant resolver", () => {
  it("resolves a known in-memory WhatsApp channel and rejects unknown channels", async () => {
    const resolver = new InMemoryTenantResolver({ "phone-known": "42" });

    await expect(resolver.resolve("phone-known")).resolves.toBe("42");
    await expect(resolver.resolve("phone-unknown")).resolves.toBeNull();
  });

  it("looks up a channel with bound SQL parameters", async () => {
    const query = vi.fn(async () => ({ rows: [{ tenant_id: 42 }] }));
    const resolver = new SqlTenantResolver({ query } satisfies SqlClient);

    await expect(resolver.resolve("phone-42", "whatsapp")).resolves.toBe("42");
    expect(query).toHaveBeenCalledWith(expect.stringContaining("FROM tenant_channels"), [
      "whatsapp",
      "phone-42",
    ]);
  });

  it("translates database failures without exposing the account id", async () => {
    const query = vi.fn(async () => {
      throw new Error("connection details for phone-private");
    });
    const resolver = new SqlTenantResolver({ query } satisfies SqlClient);

    await expect(resolver.resolve("phone-private")).rejects.toBeInstanceOf(TenantResolverError);
    await expect(resolver.resolve("phone-private")).rejects.not.toThrow("phone-private");
  });
});
