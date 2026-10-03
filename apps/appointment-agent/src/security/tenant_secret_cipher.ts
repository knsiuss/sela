/**
 * Tenant-bound authenticated encryption for non-E.164 stored secrets.
 *
 * The recipient cipher (`recipient_cipher.ts`) is deliberately E.164-only: its
 * plaintext validator is part of the PII guarantee for phone numbers, so
 * widening it to hold OAuth refresh tokens would weaken that guarantee. This
 * module therefore reuses the *existing* key material, key-id rotation, and
 * base64url codec, and only adds a generic plaintext shape plus the purpose and
 * tenant binding that the recipient cipher already models.
 *
 * Reusing `parse_recipient_key_ring` means deployments need no new key
 * material: the same overlap ring protects both ciphertext families, and the
 * additional-data binding means a ciphertext sealed for one tenant (or one
 * purpose) fails closed everywhere else.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { TextDecoder } from "node:util";
import { decode_base64url, encode_base64url } from "./recipient_cipher.js";
import { RECIPIENT_KEY_ID_PATTERN } from "./rotating_recipient_cipher.js";
import type { RecipientKeyRing } from "./recipient_key_ring.js";

/** Envelope version for generic tenant-bound secrets. */
export const TENANT_SECRET_CIPHERTEXT_VERSION = "s1";

const AES_256_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const GCM_AUTH_TAG_BYTES = 16;
const MAX_PLAINTEXT_BYTES = 1024;
const MAX_CIPHERTEXT_BYTES = 1024;
const MAX_CIPHERTEXT_CHARS = 2048;
const MAX_CONTEXT_CHARS = 256;
const MAX_KEYS = 8;
const PURPOSE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

/** Fail-closed codes that name the failure and never the secret or tenant. */
export type TenantSecretCipherErrorCode =
  | "tenant_secret_key_invalid"
  | "tenant_secret_context_invalid"
  | "tenant_secret_plaintext_invalid"
  | "tenant_secret_encryption_failed"
  | "tenant_secret_ciphertext_invalid"
  | "tenant_secret_decryption_failed";

/** Sanitized error for tenant-bound secret encryption. */
export class TenantSecretCipherError extends Error {
  /** Stable machine-readable failure code. */
  readonly code: TenantSecretCipherErrorCode;

  /** Create a sanitized tenant-secret cipher error. */
  constructor(code: TenantSecretCipherErrorCode) {
    super(`tenant-secret-cipher-failed: ${code}`);
    this.name = "TenantSecretCipherError";
    this.code = code;
  }
}

/** Seals and opens one secret bound to a tenant and a purpose. */
export interface TenantSecretCipher {
  /** Encrypt one secret for exactly one tenant and purpose. */
  encrypt(plaintext: string, context: TenantSecretContext): string;
  /** Decrypt only when the ciphertext was sealed for this tenant and purpose. */
  decrypt(ciphertext: string, context: TenantSecretContext): string;
}

/** Tenant and purpose bound into the GCM authentication tag. */
export interface TenantSecretContext {
  tenant_id: string;
  purpose: string;
}

/**
 * Build a tenant-bound AES-256-GCM cipher over the existing overlap key ring.
 *
 * @param ring - Key ring from `parse_recipient_key_ring`; keys are copied.
 * @param active_key_id - Key id used to seal new ciphertexts.
 * @throws TenantSecretCipherError when the ring or active key id is invalid.
 */
export function create_tenant_secret_cipher(
  ring: RecipientKeyRing,
  active_key_id: string = ring.active_key_id,
): TenantSecretCipher {
  const keys = copy_ring(ring.keys);
  if (!keys.has(active_key_id)) throw new TenantSecretCipherError("tenant_secret_key_invalid");
  return new AesGcmTenantSecretCipher(keys, active_key_id);
}

/** AES-256-GCM implementation with key-id metadata and context binding. */
class AesGcmTenantSecretCipher implements TenantSecretCipher {
  private readonly keys: Map<string, Buffer>;
  private readonly active_key_id: string;

  constructor(keys: Map<string, Buffer>, active_key_id: string) {
    this.keys = keys;
    this.active_key_id = active_key_id;
  }

  /**
   * Encrypt one secret into `s1.<key_id>.<iv>.<tag>.<ct>` base64url.
   *
   * @param plaintext - Bounded UTF-8 secret; never logged or returned.
   * @param context - Owning tenant and purpose, bound as additional data.
   * @returns Opaque versioned ciphertext carrying the key id.
   * @throws TenantSecretCipherError for invalid input or encryption failure.
   */
  encrypt(plaintext: string, context: TenantSecretContext): string {
    const key_id = this.active_key_id;
    const aad = additional_data(key_id, context);
    const secret = Buffer.from(require_plaintext(plaintext), "utf8");
    try {
      const iv = randomBytes(GCM_IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", active_key(this.keys, key_id), iv, {
        authTagLength: GCM_AUTH_TAG_BYTES,
      });
      cipher.setAAD(Buffer.from(aad, "utf8"));
      const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
      return [
        TENANT_SECRET_CIPHERTEXT_VERSION,
        key_id,
        encode_base64url(iv),
        encode_base64url(cipher.getAuthTag()),
        encode_base64url(ciphertext),
      ].join(".");
    } catch (error) {
      if (error instanceof TenantSecretCipherError) throw error;
      throw new TenantSecretCipherError("tenant_secret_encryption_failed");
    } finally {
      secret.fill(0);
    }
  }

  /**
   * Authenticate and decrypt a ciphertext for one tenant and purpose.
   *
   * A ciphertext sealed for a different tenant or purpose fails the GCM tag
   * check and is reported as a decryption failure, which is what makes stored
   * credentials impossible to read across tenants.
   *
   * @param ciphertext - Opaque value loaded from storage.
   * @param context - Expected tenant and purpose.
   * @returns The decrypted secret for immediate use only.
   * @throws TenantSecretCipherError for a malformed envelope, wrong context,
   * unknown key id, or a failed authentication check.
   */
  decrypt(ciphertext: string, context: TenantSecretContext): string {
    const envelope = decode_envelope(ciphertext);
    const aad = additional_data(envelope.key_id, context);
    const key = this.keys.get(envelope.key_id);
    if (key === undefined) throw new TenantSecretCipherError("tenant_secret_decryption_failed");
    let plaintext: Buffer | undefined;
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, envelope.iv, { authTagLength: GCM_AUTH_TAG_BYTES });
      decipher.setAAD(Buffer.from(aad, "utf8"));
      decipher.setAuthTag(envelope.auth_tag);
      plaintext = Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]);
      return require_plaintext(decode_utf8(plaintext));
    } catch (error) {
      if (error instanceof TenantSecretCipherError) throw error;
      throw new TenantSecretCipherError("tenant_secret_decryption_failed");
    } finally {
      plaintext?.fill(0);
    }
  }
}

interface CiphertextEnvelope {
  key_id: string;
  iv: Buffer;
  auth_tag: Buffer;
  ciphertext: Buffer;
}

/** Parse and bound the s1 envelope shape. */
function decode_envelope(encoded: string): CiphertextEnvelope {
  if (typeof encoded !== "string" || encoded.length === 0 || encoded.length > MAX_CIPHERTEXT_CHARS) {
    throw new TenantSecretCipherError("tenant_secret_ciphertext_invalid");
  }
  const parts = encoded.split(".");
  if (parts.length !== 5 || parts[0] !== TENANT_SECRET_CIPHERTEXT_VERSION) {
    throw new TenantSecretCipherError("tenant_secret_ciphertext_invalid");
  }
  const key_id = parts[1] as string;
  if (!RECIPIENT_KEY_ID_PATTERN.test(key_id)) {
    throw new TenantSecretCipherError("tenant_secret_ciphertext_invalid");
  }
  const envelope: CiphertextEnvelope = {
    key_id,
    iv: decode_base64url(parts[2]),
    auth_tag: decode_base64url(parts[3]),
    ciphertext: decode_base64url(parts[4]),
  };
  if (
    envelope.iv.byteLength !== GCM_IV_BYTES ||
    envelope.auth_tag.byteLength !== GCM_AUTH_TAG_BYTES ||
    envelope.ciphertext.byteLength === 0 ||
    envelope.ciphertext.byteLength > MAX_CIPHERTEXT_BYTES
  ) {
    throw new TenantSecretCipherError("tenant_secret_ciphertext_invalid");
  }
  return envelope;
}

/**
 * Build the GCM additional data binding key ownership, tenant, and purpose.
 *
 * @param key_id - Key that seals or opens the envelope.
 * @param context - Expected tenant and purpose.
 * @returns Canonical additional-data string.
 * @throws TenantSecretCipherError when the context is malformed.
 */
function additional_data(key_id: string, context: TenantSecretContext): string {
  return `${TENANT_SECRET_CIPHERTEXT_VERSION}:${key_id}:${require_context(context)}`;
}

/** Validate a tenant id and purpose without echoing either into the failure. */
function require_context(context: TenantSecretContext): string {
  const tenant_id = (context as TenantSecretContext | undefined)?.tenant_id;
  const purpose = (context as TenantSecretContext | undefined)?.purpose;
  if (
    typeof tenant_id !== "string" ||
    tenant_id.length < 1 ||
    tenant_id.length > MAX_CONTEXT_CHARS ||
    !/^[1-9]\d{0,18}$/.test(tenant_id) ||
    typeof purpose !== "string" ||
    !PURPOSE_PATTERN.test(purpose)
  ) {
    throw new TenantSecretCipherError("tenant_secret_context_invalid");
  }
  return `tenant:${tenant_id}:purpose:${purpose}`;
}

/** Validate one bounded UTF-8 plaintext secret. */
function require_plaintext(plaintext: string): string {
  if (
    typeof plaintext !== "string" ||
    plaintext.length < 1 ||
    Buffer.byteLength(plaintext, "utf8") > MAX_PLAINTEXT_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(plaintext)
  ) {
    throw new TenantSecretCipherError("tenant_secret_plaintext_invalid");
  }
  return plaintext;
}

/** Copy and validate ring key bytes so later ring mutation cannot affect us. */
function copy_ring(keys: ReadonlyMap<string, Uint8Array>): Map<string, Buffer> {
  const copied = new Map<string, Buffer>();
  for (const [key_id, key] of keys) {
    if (copied.size >= MAX_KEYS || !RECIPIENT_KEY_ID_PATTERN.test(key_id) || !(key instanceof Uint8Array)) {
      throw new TenantSecretCipherError("tenant_secret_key_invalid");
    }
    if (key.byteLength !== AES_256_KEY_BYTES) throw new TenantSecretCipherError("tenant_secret_key_invalid");
    copied.set(key_id, Buffer.from(key));
  }
  if (copied.size === 0) throw new TenantSecretCipherError("tenant_secret_key_invalid");
  return copied;
}

/** Fetch the active key bytes or fail closed. */
function active_key(keys: ReadonlyMap<string, Buffer>, active_key_id: string): Buffer {
  const key = keys.get(active_key_id);
  if (key === undefined) throw new TenantSecretCipherError("tenant_secret_key_invalid");
  return key;
}

/** Decode UTF-8 plaintext or fail closed. */
function decode_utf8(plaintext: Buffer): string {
  try {
    return UTF8_DECODER.decode(plaintext);
  } catch {
    throw new TenantSecretCipherError("tenant_secret_decryption_failed");
  }
}