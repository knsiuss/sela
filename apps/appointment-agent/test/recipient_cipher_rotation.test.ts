import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AesGcmRecipientCipher,
  RecipientCipherError,
} from "../src/security/recipient_cipher.js";
import {
  is_tenant_bound,
  RotatingRecipientCipher,
} from "../src/security/rotating_recipient_cipher.js";
import {
  LEGACY_SINGLE_KEY_ID,
  parse_recipient_key_ring,
  RECIPIENT_KEY_RING_ENV,
} from "../src/security/recipient_key_ring.js";

const RECIPIENT_PHONE = "+12025550123";

function key_base64(): string {
  return randomBytes(32).toString("base64");
}

function ring_env(active_key_id: string, kids: string[], keys?: Record<string, string>): Record<string, string> {
  const entries: Record<string, string> = { ...(keys ?? {}) };
  for (const kid of kids) entries[kid] ??= key_base64();
  return {
    [RECIPIENT_KEY_RING_ENV]: JSON.stringify({ active_key_id, keys: entries }),
  };
}

describe("recipient key ring", () => {
  it("maps the legacy single key to the primary key id", () => {
    const encoded = key_base64();
    const ring = parse_recipient_key_ring({
      WHATSAPP_RECIPIENT_ENCRYPTION_KEY_BASE64: encoded,
    });

    expect(ring.active_key_id).toBe(LEGACY_SINGLE_KEY_ID);
    expect([...ring.keys.keys()]).toEqual([LEGACY_SINGLE_KEY_ID]);
  });

  it("rejects missing and malformed ring configuration", () => {
    expect(() => parse_recipient_key_ring({})).toThrow("recipient_key_invalid");
    expect(() => parse_recipient_key_ring(ring_env("ghost", ["real"]))).toThrow(
      "recipient_key_invalid",
    );
    expect(() => parse_recipient_key_ring({ [RECIPIENT_KEY_RING_ENV]: "{bad" })).toThrow(
      "recipient_key_invalid",
    );
  });

  it("seals v2 envelopes carrying the active key id", () => {
    const env = ring_env("k1", ["k1"]);
    const ring = parse_recipient_key_ring(env);
    const cipher = new RotatingRecipientCipher(ring.keys, ring.active_key_id);

    const ciphertext = cipher.encrypt(RECIPIENT_PHONE);

    expect(ciphertext).toMatch(/^v2\.k1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(ciphertext).not.toContain(RECIPIENT_PHONE);
    expect(cipher.decrypt(ciphertext)).toBe(RECIPIENT_PHONE);
    expect(is_tenant_bound(cipher)).toBe(true);
    expect(is_tenant_bound(new AesGcmRecipientCipher(randomBytes(32)))).toBe(false);
  });

  it("opens legacy v1 rows with overlap keys during rotation", () => {
    const old_key = randomBytes(32);
    const legacy = new AesGcmRecipientCipher(old_key).encrypt(RECIPIENT_PHONE);
    const next_key = randomBytes(32);
    const cipher = new RotatingRecipientCipher(
      new Map([
        ["k-old", old_key],
        ["k-new", next_key],
      ]),
      "k-new",
    );

    expect(cipher.decrypt(legacy)).toBe(RECIPIENT_PHONE);
    expect(cipher.encrypt(RECIPIENT_PHONE)).toMatch(/^v2\.k-new\./);
  });

  it("binds tenant context so the wrong tenant fails closed", () => {
    const ring = parse_recipient_key_ring(ring_env("k1", ["k1"]));
    const cipher = new RotatingRecipientCipher(ring.keys, ring.active_key_id);

    const bound = cipher.encrypt_for_tenant(RECIPIENT_PHONE, "tenant-a");

    expect(cipher.decrypt_for_tenant(bound, "tenant-a")).toBe(RECIPIENT_PHONE);
    expect(() => cipher.decrypt_for_tenant(bound, "tenant-b")).toThrow(
      "recipient_decryption_failed",
    );
    expect(() => cipher.decrypt(bound)).toThrow("recipient_decryption_failed");
  });

  it("fails closed on unknown key ids without distinguishing the cause", () => {
    const ring = parse_recipient_key_ring(ring_env("k1", ["k1"]));
    const cipher = new RotatingRecipientCipher(ring.keys, ring.active_key_id);
    const tampered = cipher.encrypt(RECIPIENT_PHONE).replace(/^v2\.k1\./u, "v2.unknown.");

    expect(() => cipher.decrypt(tampered)).toThrow(RecipientCipherError);
    expect(() => cipher.decrypt(tampered)).toThrow("recipient_decryption_failed");
    expect(() => cipher.decrypt(tampered)).not.toThrow(RECIPIENT_PHONE);
  });

  it("rotates with old and new keys both decrypting", () => {
    const old_encoded = key_base64();
    const new_encoded = key_base64();
    const before = parse_recipient_key_ring({
      [RECIPIENT_KEY_RING_ENV]: JSON.stringify({
        active_key_id: "k-old",
        keys: { "k-old": old_encoded },
      }),
    });
    const before_cipher = new RotatingRecipientCipher(before.keys, before.active_key_id);
    const sealed_before = before_cipher.encrypt_for_tenant(RECIPIENT_PHONE, "tenant-a");

    const after = parse_recipient_key_ring({
      [RECIPIENT_KEY_RING_ENV]: JSON.stringify({
        active_key_id: "k-new",
        keys: { "k-old": old_encoded, "k-new": new_encoded },
      }),
    });
    const after_cipher = new RotatingRecipientCipher(after.keys, after.active_key_id);

    expect(after_cipher.decrypt_for_tenant(sealed_before, "tenant-a")).toBe(RECIPIENT_PHONE);
    expect(after_cipher.encrypt(RECIPIENT_PHONE)).toMatch(/^v2\.k-new\./);
  });
});
