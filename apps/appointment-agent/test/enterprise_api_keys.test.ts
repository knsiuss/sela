import { describe, expect, it } from "vitest";
import { parse_authenticated_principal } from "../src/enterprise/authorization.js";
import {
  create_api_key,
  handle_rotate_api_key_request,
  revoke_api_key,
  rotate_api_key,
  verify_api_key,
  ApiKeyError,
  InMemoryApiKeyStore,
} from "../src/enterprise/api_keys.js";

const CLOCK = () => new Date("2026-09-30T00:00:00.000Z");
const MANAGER = parse_authenticated_principal({
  subject_id: "owner-1",
  session_id: "session-1",
  has_mfa: true,
  issued_at_iso: "2026-09-30T00:00:00.000Z",
  tenant_roles: { "42": ["owner"] },
});

describe("api keys with scopes and expiry", () => {
  it("creates a key and verifies the one-time secret", () => {
    const issued = create_api_key({ tenant_id: "42", scopes: ["appointments:read"], ttl_days: 30, clock: CLOCK });
    expect(issued.record.key_id).toMatch(/^ak_[0-9a-f]{16}$/);
    expect(() => verify_api_key(issued.secret, issued.record, new Date("2026-10-01T00:00:00.000Z")))
      .not.toThrow();
    expect(JSON.stringify(issued.record)).not.toContain(issued.secret);
  });

  it("rejects unknown scopes and bad ttl fail-fast", () => {
    expect(() => create_api_key({ tenant_id: "42", scopes: ["nope" as never], ttl_days: 30, clock: CLOCK }))
      .toThrow(ApiKeyError);
    expect(() => create_api_key({ tenant_id: "42", scopes: ["appointments:read"], ttl_days: 0, clock: CLOCK }))
      .toThrow("api-key-ttl-invalid");
  });

  it("rejects wrong secrets, expired keys, and revoked keys", () => {
    const issued = create_api_key({ tenant_id: "42", scopes: ["audit:read"], ttl_days: 1, clock: CLOCK });
    expect(() => verify_api_key("wrong-secret-value-1234567890", issued.record, CLOCK())).toThrow("api-key-mismatch");
    expect(() => verify_api_key(issued.secret, issued.record, new Date("2027-01-01T00:00:00.000Z")))
      .toThrow("api-key-expired");
    const revoked = revoke_api_key(issued.record, CLOCK);
    expect(() => verify_api_key(issued.secret, revoked, CLOCK())).toThrow("api-key-revoked");
    expect(() => revoke_api_key(revoked, CLOCK)).toThrow("api-key-already-revoked");
  });

  it("rotates a key with predecessor linkage and revokes the old", () => {
    const first = create_api_key({ tenant_id: "42", scopes: ["audit:read"], ttl_days: 30, clock: CLOCK });
    const rotated = rotate_api_key(first.record, { tenant_id: "42", scopes: ["audit:read"], ttl_days: 30, clock: CLOCK });
    expect(rotated.issued.record.predecessor_key_id).toBe(first.record.key_id);
    expect(rotated.issued.secret).not.toBe(first.secret);
    expect(rotated.revoked.revoked_at_iso).toBe(rotated.issued.record.created_at_iso);
    expect(() => verify_api_key(first.secret, rotated.revoked, CLOCK())).toThrow("api-key-revoked");
  });

  it("authorizes rotation through tenant:manage only", async () => {
    const store = new InMemoryApiKeyStore();
    const first = create_api_key({ tenant_id: "42", scopes: ["audit:read"], ttl_days: 30, clock: CLOCK });
    await store.save(first.record);
    const { revoked, issued } = handle_rotate_api_key_request(
      MANAGER, "42", first.record, { tenant_id: "42", scopes: ["audit:read"], ttl_days: 30, clock: CLOCK },
    );
    expect(revoked.revoked_at_iso).not.toBeNull();
    expect(issued.record.predecessor_key_id).toBe(first.record.key_id);
    const outsider = parse_authenticated_principal({
      subject_id: "op-1", session_id: "s-1", has_mfa: true,
      issued_at_iso: "2026-09-30T00:00:00.000Z", tenant_roles: { "42": ["operator"] },
    });
    expect(() => handle_rotate_api_key_request(
      outsider, "42", first.record, { tenant_id: "42", scopes: ["audit:read"], ttl_days: 30, clock: CLOCK },
    )).toThrow();
  });
});
