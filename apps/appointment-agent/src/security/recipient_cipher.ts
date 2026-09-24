/** Versioned encryption boundary for transient WhatsApp recipient phone numbers. */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { TextDecoder } from "node:util";

/** Environment variable containing a canonical base64-encoded 32-byte key. */
export const RECIPIENT_CIPHER_KEY_ENV = "WHATSAPP_RECIPIENT_ENCRYPTION_KEY_BASE64";

/** Current compact ciphertext envelope version. */
export const RECIPIENT_CIPHERTEXT_VERSION = "v1";

const AES_256_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const GCM_AUTH_TAG_BYTES = 16;
const MAX_RECIPIENT_CIPHERTEXT_CHARS = 512;
const MAX_RECIPIENT_PLAINTEXT_BYTES = 32;
const E164_PATTERN = /^\+[1-9]\d{7,14}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const CANONICAL_BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

/** Sanitized failure codes safe to translate or log without recipient data. */
export type RecipientCipherErrorCode =
  | "recipient_key_invalid"
  | "recipient_cipher_unavailable"
  | "recipient_phone_invalid"
  | "recipient_encryption_failed"
  | "recipient_ciphertext_invalid"
  | "recipient_decryption_failed";

/** Fail-closed recipient encryption error that never contains key or phone data. */
export class RecipientCipherError extends Error {
  /** Stable machine-readable failure code. */
  readonly code: RecipientCipherErrorCode;

  /** Create a sanitized recipient cipher error. */
  constructor(code: RecipientCipherErrorCode) {
    super(`recipient-cipher-failed: ${code}`);
    this.name = "RecipientCipherError";
    this.code = code;
  }
}

/** Injectable encryption port used at ingress and worker boundaries. */
export interface RecipientCipher {
  /** Encrypt one strict E.164 recipient into a versioned opaque string. */
  encrypt(recipient_phone_e164: string): string;
  /** Authenticate and decrypt one opaque recipient ciphertext. */
  decrypt(reply_target_ciphertext: string): string;
}

/**
 * Parse a canonical base64 AES-256 key without reading process environment.
 *
 * @param encoded_key - Base64 text expected to decode to exactly 32 bytes.
 * @returns A new Buffer safe for injection into the cipher constructor.
 * @throws RecipientCipherError when the key encoding or length is invalid.
 */
export function parse_recipient_cipher_key(encoded_key: string | undefined): Buffer {
  if (
    typeof encoded_key !== "string" ||
    !CANONICAL_BASE64_PATTERN.test(encoded_key) ||
    encoded_key.length === 0
  ) {
    throw new RecipientCipherError("recipient_key_invalid");
  }
  const key = Buffer.from(encoded_key, "base64");
  if (key.byteLength !== AES_256_KEY_BYTES || key.toString("base64") !== encoded_key) {
    key.fill(0);
    throw new RecipientCipherError("recipient_key_invalid");
  }
  return key;
}

/** AES-256-GCM implementation using a unique 96-bit IV for every encryption. */
export class AesGcmRecipientCipher implements RecipientCipher {
  private readonly key: Buffer;

  /**
   * Create a recipient cipher from raw key bytes.
   *
   * @param key - Exactly 32 key bytes; use `parse_recipient_cipher_key` for env input.
   * @throws RecipientCipherError when the key length is invalid.
   */
  constructor(key: Uint8Array) {
    if (!(key instanceof Uint8Array) || key.byteLength !== AES_256_KEY_BYTES) {
      throw new RecipientCipherError("recipient_key_invalid");
    }
    this.key = Buffer.from(key);
  }

  /**
   * Encrypt one strict E.164 phone number into `v1.iv.tag.ciphertext` base64url.
   *
   * @param recipient_phone_e164 - Untrusted recipient normalized to strict E.164.
   * @returns Opaque, versioned, authenticated ciphertext.
   * @throws RecipientCipherError for invalid input or encryption failure.
   */
  encrypt(recipient_phone_e164: string): string {
    const plaintext = Buffer.from(require_e164(recipient_phone_e164), "utf8");
    try {
      const iv = randomBytes(GCM_IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", this.key, iv, {
        authTagLength: GCM_AUTH_TAG_BYTES,
      });
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const auth_tag = cipher.getAuthTag();
      return [
        RECIPIENT_CIPHERTEXT_VERSION,
        encode_base64url(iv),
        encode_base64url(auth_tag),
        encode_base64url(ciphertext),
      ].join(".");
    } catch (error) {
      if (error instanceof RecipientCipherError) throw error;
      throw new RecipientCipherError("recipient_encryption_failed");
    } finally {
      plaintext.fill(0);
    }
  }

  /**
   * Authenticate and decrypt one versioned recipient ciphertext.
   *
   * @param reply_target_ciphertext - Opaque value loaded from inbound_messages.
   * @returns Strict E.164 recipient for immediate outbound use only.
   * @throws RecipientCipherError when the envelope, key, tag, or plaintext is invalid.
   */
  decrypt(reply_target_ciphertext: string): string {
    const envelope = decode_ciphertext(reply_target_ciphertext);
    let plaintext: Buffer | undefined;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, envelope.iv, {
        authTagLength: GCM_AUTH_TAG_BYTES,
      });
      decipher.setAuthTag(envelope.auth_tag);
      plaintext = Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]);
      return require_e164(decode_utf8(plaintext));
    } catch (error) {
      if (error instanceof RecipientCipherError) throw error;
      throw new RecipientCipherError("recipient_decryption_failed");
    } finally {
      plaintext?.fill(0);
    }
  }
}

/** Non-persistent cipher for explicit local/test in-memory composition only. */
export class EphemeralRecipientCipher extends AesGcmRecipientCipher {
  /** Create a cipher with a random key that cannot decrypt rows after restart. */
  constructor() {
    super(randomBytes(AES_256_KEY_BYTES));
  }
}

interface CiphertextEnvelope {
  iv: Buffer;
  auth_tag: Buffer;
  ciphertext: Buffer;
}

function decode_ciphertext(encoded: string): CiphertextEnvelope {
  if (typeof encoded !== "string" || encoded.length === 0 || encoded.length > MAX_RECIPIENT_CIPHERTEXT_CHARS) {
    throw new RecipientCipherError("recipient_ciphertext_invalid");
  }
  const parts = encoded.split(".");
  if (parts.length !== 4 || parts[0] !== RECIPIENT_CIPHERTEXT_VERSION) {
    throw new RecipientCipherError("recipient_ciphertext_invalid");
  }
  const envelope: CiphertextEnvelope = {
    iv: decode_base64url(parts[1]),
    auth_tag: decode_base64url(parts[2]),
    ciphertext: decode_base64url(parts[3]),
  };
  if (
    envelope.iv.byteLength !== GCM_IV_BYTES ||
    envelope.auth_tag.byteLength !== GCM_AUTH_TAG_BYTES ||
    envelope.ciphertext.byteLength === 0 ||
    envelope.ciphertext.byteLength > MAX_RECIPIENT_PLAINTEXT_BYTES
  ) {
    throw new RecipientCipherError("recipient_ciphertext_invalid");
  }
  return envelope;
}

function decode_base64url(value: string | undefined): Buffer {
  if (
    value === undefined ||
    !BASE64URL_PATTERN.test(value) ||
    value.includes("=")
  ) {
    throw new RecipientCipherError("recipient_ciphertext_invalid");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength === 0 || decoded.toString("base64url") !== value) {
    decoded.fill(0);
    throw new RecipientCipherError("recipient_ciphertext_invalid");
  }
  return decoded;
}

function encode_base64url(value: Buffer): string {
  return value.toString("base64url");
}

function require_e164(value: string): string {
  if (typeof value !== "string" || !E164_PATTERN.test(value)) {
    throw new RecipientCipherError("recipient_phone_invalid");
  }
  return value;
}

function decode_utf8(plaintext: Buffer): string {
  try {
    return UTF8_DECODER.decode(plaintext);
  } catch {
    throw new RecipientCipherError("recipient_decryption_failed");
  }
}
