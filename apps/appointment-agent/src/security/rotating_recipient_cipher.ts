/** Rotating AES-256-GCM cipher with key-id metadata and tenant binding. */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { TextDecoder } from "node:util";
import {
  decode_base64url,
  encode_base64url,
  require_e164,
  RecipientCipherError,
  type RecipientCipher,
} from "./recipient_cipher.js";

/** Envelope version carrying key-id metadata for rotation. */
export const RECIPIENT_CIPHERTEXT_VERSION_V2 = "v2";

/** Key-id shape shared by envelope parsing and ring configuration. */
export const RECIPIENT_KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

// AES-GCM standard parameters, matching the v1 cipher module.
const GCM_IV_BYTES = 12;
const GCM_AUTH_TAG_BYTES = 16;
const AES_256_KEY_BYTES = 32;
const MAX_RING_KEYS = 8;
const MAX_TENANT_CONTEXT_CHARS = 256;
const MAX_CIPHERTEXT_CHARS = 512;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

/** Recipient cipher with explicit per-tenant encryption context. */
export interface TenantBoundRecipientCipher extends RecipientCipher {
  /**
   * Encrypt one recipient binding the ciphertext to a tenant.
   *
   * @param recipient_phone_e164 - Untrusted recipient in strict E.164.
   * @param tenant_id - Owning tenant bound as GCM additional data.
   * @returns Opaque v2 ciphertext carrying the key id.
   */
  encrypt_for_tenant(recipient_phone_e164: string, tenant_id: string): string;
  /**
   * Decrypt one ciphertext only for its bound tenant.
   *
   * @param reply_target_ciphertext - Opaque v2 (or legacy v1) ciphertext.
   * @param tenant_id - Expected owning tenant.
   * @returns Strict E.164 recipient for immediate outbound use only.
   */
  decrypt_for_tenant(reply_target_ciphertext: string, tenant_id: string): string;
}

/**
 * Check for explicit tenant-bound encryption support.
 *
 * @param cipher - Injected recipient cipher.
 * @returns True when tenant-context methods are available.
 */
export function is_tenant_bound(cipher: RecipientCipher): cipher is TenantBoundRecipientCipher {
  if (typeof cipher !== "object" || cipher === null) return false;
  const candidate = cipher as Partial<TenantBoundRecipientCipher>;
  return typeof candidate.encrypt_for_tenant === "function" && typeof candidate.decrypt_for_tenant === "function";
}

/**
 * Rotating AES-256-GCM cipher with key-id metadata and tenant AAD binding.
 *
 * New ciphertexts use the `v2.<key_id>.<iv>.<tag>.<ct>` envelope with the
 * key id and (for tenant calls) the tenant id as GCM additional data.
 * Decryption accepts legacy v1 envelopes through overlap keys without AAD.
 * Deploy readers before writers: v1-only readers fail closed on v2 rows.
 */
export class RotatingRecipientCipher implements TenantBoundRecipientCipher {
  private readonly keys: Map<string, Buffer>;
  private readonly active_key_id: string;

  /**
   * Create the rotating cipher from copied key bytes.
   *
   * @param keys - At most 8 key ids to exactly 32 key bytes each.
   * @param active_key_id - Key id used for new encryptions.
   * @throws RecipientCipherError when the ring is empty or invalid.
   */
  constructor(keys: ReadonlyMap<string, Uint8Array>, active_key_id: string) {
    const copied = copy_ring(keys);
    if (!RECIPIENT_KEY_ID_PATTERN.test(active_key_id) || !copied.has(active_key_id)) {
      throw new RecipientCipherError("recipient_key_invalid");
    }
    this.keys = copied;
    this.active_key_id = active_key_id;
  }

  /**
   * Encrypt with the active key and key-id ownership binding.
   *
   * @param recipient_phone_e164 - Untrusted recipient in strict E.164.
   * @returns Opaque v2 ciphertext.
   */
  encrypt(recipient_phone_e164: string): string {
    return seal(active_key(this.keys, this.active_key_id), this.active_key_id, recipient_phone_e164);
  }

  /**
   * Decrypt v2 or legacy v1 ciphertext without a tenant expectation.
   *
   * @param reply_target_ciphertext - Opaque ciphertext from storage.
   * @returns Strict E.164 recipient for immediate outbound use only.
   */
  decrypt(reply_target_ciphertext: string): string {
    return open_mixed(this.keys, reply_target_ciphertext);
  }

  /**
   * Encrypt binding the ciphertext to one tenant via GCM additional data.
   *
   * @param recipient_phone_e164 - Untrusted recipient in strict E.164.
   * @param tenant_id - Owning tenant bound into the authentication tag.
   * @returns Opaque v2 ciphertext.
   */
  encrypt_for_tenant(recipient_phone_e164: string, tenant_id: string): string {
    return seal(
      active_key(this.keys, this.active_key_id),
      this.active_key_id,
      recipient_phone_e164,
      require_tenant_context(tenant_id),
    );
  }

  /**
   * Decrypt only when the ciphertext is bound to the expected tenant.
   *
   * Legacy v1 rows predate tenant binding and still open through overlap
   * keys; v2 rows with another tenant fail closed.
   *
   * @param reply_target_ciphertext - Opaque ciphertext from storage.
   * @param tenant_id - Expected owning tenant.
   * @returns Strict E.164 recipient for immediate outbound use only.
   */
  decrypt_for_tenant(reply_target_ciphertext: string, tenant_id: string): string {
    return open_mixed(this.keys, reply_target_ciphertext, require_tenant_context(tenant_id));
  }
}

/** Seal one phone into a v2 envelope with ownership and tenant binding. */
function seal(
  key: Buffer,
  key_id: string,
  recipient_phone_e164: string,
  tenant_id?: string,
): string {
  const plaintext = Buffer.from(require_e164(recipient_phone_e164), "utf8");
  try {
    const iv = randomBytes(GCM_IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: GCM_AUTH_TAG_BYTES });
    cipher.setAAD(Buffer.from(aad_for(key_id, tenant_id), "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return [
      RECIPIENT_CIPHERTEXT_VERSION_V2,
      key_id,
      encode_base64url(iv),
      encode_base64url(cipher.getAuthTag()),
      encode_base64url(ciphertext),
    ].join(".");
  } catch (error) {
    if (error instanceof RecipientCipherError) throw error;
    throw new RecipientCipherError("recipient_encryption_failed");
  } finally {
    plaintext.fill(0);
  }
}

/** Open v2 directly or v1 through overlap keys. */
function open_mixed(
  keys: ReadonlyMap<string, Buffer>,
  encoded: string,
  tenant_id?: string,
): string {
  if (typeof encoded !== "string" || encoded.length === 0 || encoded.length > MAX_CIPHERTEXT_CHARS) {
    throw new RecipientCipherError("recipient_ciphertext_invalid");
  }
  const parts = encoded.split(".");
  if (parts[0] === RECIPIENT_CIPHERTEXT_VERSION_V2) {
    return open_v2(keys, parts, tenant_id);
  }
  return open_v1_overlap(keys, encoded);
}

/** Open one v2 envelope with its key id and expected binding. */
function open_v2(
  keys: ReadonlyMap<string, Buffer>,
  parts: string[],
  tenant_id: string | undefined,
): string {
  if (parts.length !== 5 || !RECIPIENT_KEY_ID_PATTERN.test(parts[1] ?? "")) {
    throw new RecipientCipherError("recipient_ciphertext_invalid");
  }
  const key_id = parts[1] as string;
  const key = keys.get(key_id);
  const envelope = {
    iv: decode_base64url(parts[2]),
    auth_tag: decode_base64url(parts[3]),
    ciphertext: decode_base64url(parts[4]),
  };
  if (
    envelope.iv.byteLength !== GCM_IV_BYTES ||
    envelope.auth_tag.byteLength !== GCM_AUTH_TAG_BYTES ||
    envelope.ciphertext.byteLength === 0 ||
    envelope.ciphertext.byteLength > MAX_CIPHERTEXT_CHARS
  ) {
    throw new RecipientCipherError("recipient_ciphertext_invalid");
  }
  if (key === undefined) throw new RecipientCipherError("recipient_decryption_failed");
  let plaintext: Buffer | undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, envelope.iv, {
      authTagLength: GCM_AUTH_TAG_BYTES,
    });
    decipher.setAAD(Buffer.from(aad_for(key_id, tenant_id), "utf8"));
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

/** Open a legacy v1 envelope with any overlap key (no tenant binding). */
function open_v1_overlap(keys: ReadonlyMap<string, Buffer>, encoded: string): string {
  const parts = encoded.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new RecipientCipherError("recipient_ciphertext_invalid");
  }
  const envelope = {
    iv: decode_base64url(parts[1]),
    auth_tag: decode_base64url(parts[2]),
    ciphertext: decode_base64url(parts[3]),
  };
  if (
    envelope.iv.byteLength !== GCM_IV_BYTES ||
    envelope.auth_tag.byteLength !== GCM_AUTH_TAG_BYTES ||
    envelope.ciphertext.byteLength === 0 ||
    envelope.ciphertext.byteLength > MAX_CIPHERTEXT_CHARS
  ) {
    throw new RecipientCipherError("recipient_ciphertext_invalid");
  }
  for (const key of keys.values()) {
    const plaintext = try_open_v1(key, envelope);
    if (plaintext !== undefined) return plaintext;
  }
  throw new RecipientCipherError("recipient_decryption_failed");
}

/** Attempt one v1 open; undefined means try the next overlap key. */
function try_open_v1(
  key: Buffer,
  envelope: { iv: Buffer; auth_tag: Buffer; ciphertext: Buffer },
): string | undefined {
  let plaintext: Buffer | undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, envelope.iv, {
      authTagLength: GCM_AUTH_TAG_BYTES,
    });
    decipher.setAuthTag(envelope.auth_tag);
    plaintext = Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]);
    return require_e164(decode_utf8(plaintext));
  } catch {
    return undefined;
  } finally {
    plaintext?.fill(0);
  }
}

/** Copy and validate ring key bytes. */
function copy_ring(keys: ReadonlyMap<string, Uint8Array>): Map<string, Buffer> {
  const copied = new Map<string, Buffer>();
  for (const [key_id, key] of keys) {
    if (copied.size >= MAX_RING_KEYS) throw new RecipientCipherError("recipient_key_invalid");
    if (
      !RECIPIENT_KEY_ID_PATTERN.test(key_id) ||
      !(key instanceof Uint8Array) ||
      key.byteLength !== AES_256_KEY_BYTES
    ) {
      throw new RecipientCipherError("recipient_key_invalid");
    }
    copied.set(key_id, Buffer.from(key));
  }
  if (copied.size === 0) throw new RecipientCipherError("recipient_key_invalid");
  return copied;
}

/** Fetch the active key bytes or fail closed. */
function active_key(keys: ReadonlyMap<string, Buffer>, active_key_id: string): Buffer {
  const key = keys.get(active_key_id);
  if (key === undefined) throw new RecipientCipherError("recipient_key_invalid");
  return key;
}

/** Build the GCM additional data binding key ownership and tenant. */
function aad_for(key_id: string, tenant_id: string | undefined): string {
  return tenant_id === undefined ? `v2:${key_id}` : `v2:${key_id}\ntenant:${tenant_id}`;
}

/** Validate a tenant encryption-context value without echoing it. */
function require_tenant_context(tenant_id: string): string {
  if (
    typeof tenant_id !== "string" ||
    tenant_id.trim() === "" ||
    tenant_id.length > MAX_TENANT_CONTEXT_CHARS ||
    tenant_id.trim() !== tenant_id ||
    /[\u0000-\u001f\u007f]/u.test(tenant_id)
  ) {
    throw new RecipientCipherError("recipient_phone_invalid");
  }
  return tenant_id;
}

/** Decode UTF-8 plaintext or fail closed. */
function decode_utf8(plaintext: Buffer): string {
  try {
    return UTF8_DECODER.decode(plaintext);
  } catch {
    throw new RecipientCipherError("recipient_decryption_failed");
  }
}
