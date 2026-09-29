/** Recipient encryption-key ownership and overlap ring parsing. */

import {
  parse_recipient_cipher_key,
  RECIPIENT_CIPHER_KEY_ENV,
  RecipientCipherError,
} from "./recipient_cipher.js";
import { RECIPIENT_KEY_ID_PATTERN } from "./rotating_recipient_cipher.js";

/** Environment variable carrying the overlap key-ring JSON. */
export const RECIPIENT_KEY_RING_ENV = "WHATSAPP_RECIPIENT_ENCRYPTION_KEYS_JSON";

/** Key id assigned when only the legacy single-key variable is configured. */
export const LEGACY_SINGLE_KEY_ID = "primary";

const MAX_RING_KEYS = 8;
const MAX_RING_JSON_CHARS = 8192;

/** Parsed key ring: copied key bytes plus the active encryption key id. */
export interface RecipientKeyRing {
  keys: Map<string, Buffer>;
  active_key_id: string;
}

/**
 * Parse the recipient key ring from environment.
 *
 * When WHATSAPP_RECIPIENT_ENCRYPTION_KEYS_JSON is set it must carry
 * `{"active_key_id": "<kid>", "keys": {"<kid>": "<base64>"}}` with at most 8
 * keys for old/new overlap. Otherwise the legacy single-key variable maps to
 * the `primary` key id so new ciphertexts still carry version metadata.
 *
 * @param env - Environment mapping.
 * @returns Copied key bytes owned by the caller.
 * @throws RecipientCipherError when no key or invalid ring input is present.
 */
export function parse_recipient_key_ring(
  env: Record<string, string | undefined>,
): RecipientKeyRing {
  const ring_json = env[RECIPIENT_KEY_RING_ENV];
  if (ring_json !== undefined && ring_json !== "") return parse_ring_json(ring_json);
  const legacy = env[RECIPIENT_CIPHER_KEY_ENV];
  if (legacy === undefined || legacy === "") throw new RecipientCipherError("recipient_key_invalid");
  return {
    keys: new Map([[LEGACY_SINGLE_KEY_ID, parse_recipient_cipher_key(legacy)]]),
    active_key_id: LEGACY_SINGLE_KEY_ID,
  };
}

/** Parse and validate the overlap ring JSON. */
function parse_ring_json(raw: string): RecipientKeyRing {
  if (raw.length > MAX_RING_JSON_CHARS) throw new RecipientCipherError("recipient_key_invalid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RecipientCipherError("recipient_key_invalid");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new RecipientCipherError("recipient_key_invalid");
  }
  const record = parsed as { active_key_id?: unknown; keys?: unknown };
  if (typeof record.active_key_id !== "string" || !RECIPIENT_KEY_ID_PATTERN.test(record.active_key_id)) {
    throw new RecipientCipherError("recipient_key_invalid");
  }
  if (typeof record.keys !== "object" || record.keys === null || Array.isArray(record.keys)) {
    throw new RecipientCipherError("recipient_key_invalid");
  }
  const keys = new Map<string, Buffer>();
  for (const [key_id, encoded] of Object.entries(record.keys)) {
    if (keys.size >= MAX_RING_KEYS) throw new RecipientCipherError("recipient_key_invalid");
    if (!RECIPIENT_KEY_ID_PATTERN.test(key_id) || typeof encoded !== "string") {
      throw new RecipientCipherError("recipient_key_invalid");
    }
    keys.set(key_id, parse_recipient_cipher_key(encoded));
  }
  if (!keys.has(record.active_key_id)) throw new RecipientCipherError("recipient_key_invalid");
  return { keys, active_key_id: record.active_key_id };
}
