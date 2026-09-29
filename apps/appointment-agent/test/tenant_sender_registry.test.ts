import { describe, expect, it } from "vitest";
import { TenantSecretSenderRegistry } from "../src/outbound/tenant_sender_registry.js";
import { OutboundSenderRegistryError } from "../src/outbound/sender_registry.js";
import {
  collect_binding_refs,
  parse_tenant_sender_bindings,
  TenantSenderCredentialStore,
} from "../src/security/tenant_sender_credentials.js";
import {
  AuditedSecretManager,
  EnvSecretManager,
  InMemorySecretAccessSink,
  SecretManagerError,
} from "../src/security/secret_manager.js";
import type { OutboundSenderPort } from "../src/worker/loop.js";
import type { OutboundDraft } from "../src/worker/process_job.js";

const DRAFT: OutboundDraft = {
  to: "+15551234567",
  message_type: "text",
  text: "Choose a time",
  inbound_wamid: "wamid-tenant-test",
  turn_id: "0",
};

const MAPPING_JSON = JSON.stringify({
  "tenant-a": {
    phone_number_id_ref: "WHATSAPP_TENANT_A_PHONE_NUMBER_ID",
    access_token_ref: "WHATSAPP_TENANT_A_API_TOKEN",
  },
  "tenant-b": {
    phone_number_id_ref: "WHATSAPP_TENANT_B_PHONE_NUMBER_ID",
    access_token_ref: "WHATSAPP_TENANT_B_API_TOKEN",
  },
});

const ENV = {
  WHATSAPP_TENANT_A_PHONE_NUMBER_ID: "phone-tenant-a",
  WHATSAPP_TENANT_A_API_TOKEN: "test-token-tenant-a",
  WHATSAPP_TENANT_B_PHONE_NUMBER_ID: "phone-tenant-b",
  WHATSAPP_TENANT_B_API_TOKEN: "test-token-tenant-b",
};

function make_store(
  env: Record<string, string | undefined> = ENV,
  mapping_json: string | undefined = MAPPING_JSON,
  sink = new InMemorySecretAccessSink(),
): { store: TenantSenderCredentialStore; sink: InMemorySecretAccessSink } {
  const bindings = parse_tenant_sender_bindings(mapping_json);
  const manager = new AuditedSecretManager(
    new EnvSecretManager(env, collect_binding_refs(bindings)),
    sink,
  );
  return { store: new TenantSenderCredentialStore(manager, bindings, { sink }), sink };
}

function stub_factory(seen: string[]): OutboundSenderPort {
  return {
    send: async (draft: OutboundDraft) => {
      seen.push(draft.to);
      return { status: "sent" };
    },
  };
}

describe("tenant sender credentials", () => {
  it("parses a bounded tenant binding map", () => {
    const bindings = parse_tenant_sender_bindings(MAPPING_JSON);

    expect([...bindings.keys()].sort()).toEqual(["tenant-a", "tenant-b"]);
    expect(parse_tenant_sender_bindings(undefined).size).toBe(0);
    expect(parse_tenant_sender_bindings("").size).toBe(0);
    expect(() => parse_tenant_sender_bindings("{invalid")).toThrow("secret-mapping-invalid");
    expect(() => parse_tenant_sender_bindings("[]")).toThrow("secret-mapping-invalid");
  });

  it("resolves per-tenant credentials and fails closed when unmapped", () => {
    const { store } = make_store();

    expect(store.resolve("tenant-a")).toEqual({
      phone_number_id: "phone-tenant-a",
      access_token: "test-token-tenant-a",
    });
    expect(() => store.resolve("tenant-unknown")).toThrow(SecretManagerError);
    expect(() => store.resolve("tenant-unknown")).toThrow("secret-not-configured");
  });

  it("revokes a tenant so subsequent resolution fails closed", () => {
    const { store, sink } = make_store();

    expect(store.resolve("tenant-a").access_token).toBe("test-token-tenant-a");
    store.revoke("tenant-a");

    expect(store.is_revoked("tenant-a")).toBe(true);
    expect(() => store.resolve("tenant-a")).toThrow("secret-revoked");
    expect(sink.events.filter((event) => event.operation === "revoke")).toHaveLength(1);
    expect(JSON.stringify(sink.events)).not.toContain("test-token-tenant-a");
  });

  it("fails closed when a bound secret value is missing", () => {
    const { store } = make_store({});

    expect(() => store.resolve("tenant-a")).toThrow("secret-not-configured");
  });

  it("rejects malformed tenant ids without resolving", () => {
    const { store } = make_store();

    expect(() => store.resolve("")).toThrow(SecretManagerError);
    expect(() => store.resolve(" tenant-a ")).toThrow(SecretManagerError);
    expect(() => store.revoke("")).toThrow(SecretManagerError);
  });
});

describe("tenant secret sender registry", () => {
  it("routes sends through the tenant's own sender", async () => {
    const { store } = make_store();
    const sent_a: string[] = [];
    const sent_b: string[] = [];
    const registry = new TenantSecretSenderRegistry({
      credential_store: store,
      sender_factory: (_credentials, tenant_id) =>
        stub_factory(tenant_id === "tenant-a" ? sent_a : sent_b),
    });

    await registry.send("tenant-a", DRAFT);
    await registry.send("tenant-b", DRAFT);

    expect(sent_a).toEqual([DRAFT.to]);
    expect(sent_b).toEqual([DRAFT.to]);
    expect(registry.configured_tenants()).toEqual(["tenant-a", "tenant-b"]);
  });

  it("fails closed before provider I/O for an unmapped tenant", async () => {
    const { store } = make_store();
    let factory_calls = 0;
    const registry = new TenantSecretSenderRegistry({
      credential_store: store,
      sender_factory: () => {
        factory_calls += 1;
        return stub_factory([]);
      },
    });

    await expect(registry.send("tenant-unknown", DRAFT)).rejects.toBeInstanceOf(
      OutboundSenderRegistryError,
    );
    expect(factory_calls).toBe(0);
  });

  it("drops the cached sender on emergency revocation", async () => {
    const { store } = make_store();
    let factory_calls = 0;
    const registry = new TenantSecretSenderRegistry({
      credential_store: store,
      sender_factory: () => {
        factory_calls += 1;
        return stub_factory([]);
      },
    });

    await registry.send("tenant-a", DRAFT);
    expect(factory_calls).toBe(1);
    registry.revoke_tenant("tenant-a");

    await expect(registry.send("tenant-a", DRAFT)).rejects.toMatchObject({
      code: "tenant_sender_not_configured",
    });
    expect(factory_calls).toBe(1);
  });
});
