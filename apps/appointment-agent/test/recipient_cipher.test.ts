import { describe, expect, it } from "vitest";
import {
  AesGcmRecipientCipher,
  parse_recipient_cipher_key,
  RecipientCipherError,
} from "../src/security/recipient_cipher.js";

const KEY_BYTES = Buffer.alloc(32, 7);
const RECIPIENT_PHONE = "+12025550123";

function make_cipher(key = KEY_BYTES): AesGcmRecipientCipher {
  return new AesGcmRecipientCipher(key);
}

describe("recipient cipher", () => {
  it("parses only a canonical base64 encoding of exactly 32 key bytes", () => {
    expect(parse_recipient_cipher_key(KEY_BYTES.toString("base64"))).toEqual(KEY_BYTES);
    expect(() => parse_recipient_cipher_key(undefined)).toThrow(RecipientCipherError);
    expect(() => parse_recipient_cipher_key(Buffer.alloc(16).toString("base64"))).toThrow(RecipientCipherError);
    expect(() => parse_recipient_cipher_key("not-base64!")).toThrow(RecipientCipherError);
  });

  it("round-trips a versioned compact ciphertext with a unique IV", () => {
    const cipher = make_cipher();
    const first = cipher.encrypt(RECIPIENT_PHONE);
    const second = cipher.encrypt(RECIPIENT_PHONE);

    expect(first).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(first).not.toContain(RECIPIENT_PHONE);
    expect(first).not.toBe(second);
    expect(cipher.decrypt(first)).toBe(RECIPIENT_PHONE);
  });

  it("fails closed with a sanitized error when the key is wrong", () => {
    const ciphertext = make_cipher().encrypt(RECIPIENT_PHONE);
    const wrong_cipher = make_cipher(Buffer.alloc(32, 8));
    const attempt = () => wrong_cipher.decrypt(ciphertext);

    expect(attempt).toThrow(RecipientCipherError);
    expect(attempt).toThrow("recipient_decryption_failed");
    expect(attempt).not.toThrow(RECIPIENT_PHONE);
    expect(attempt).not.toThrow(ciphertext);
  });

  it.each(["15551234567", "+0123456789", "+1234567890123456", "+123 456 7890", ""])(
    "rejects non-strict E.164 input without echoing it",
    (recipient_phone) => {
      const attempt = () => make_cipher().encrypt(recipient_phone);

      expect(attempt).toThrow(RecipientCipherError);
      expect(attempt).toThrow("recipient_phone_invalid");
      if (recipient_phone !== "") expect(attempt).not.toThrow(recipient_phone);
    },
  );

  it("rejects malformed and unsupported ciphertext envelopes", () => {
    const cipher = make_cipher();

    expect(() => cipher.decrypt("v2.invalid")).toThrow("recipient_ciphertext_invalid");
    expect(() => cipher.decrypt("not-an-envelope")).toThrow("recipient_ciphertext_invalid");
  });
});
