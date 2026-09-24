import { createHash } from "node:crypto";
import type { OutboundMessage } from "./types.js";

export {
  IdempotencyCache,
  IdempotencyCoordinator,
  InMemoryIdempotencyCache,
  InMemoryIdempotencyStore,
} from "./idempotency_store.js";
export type { IdempotencyCoordinatorOptions, InMemoryIdempotencyStoreOptions } from "./idempotency_store.js";

/** Maximum length of an application-supplied idempotency key. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

/** Default lifetime of a completed in-memory idempotency record. */
export const DEFAULT_IDEMPOTENCY_TTL_MS = 15 * 60 * 1000;

/** Default maximum number of records retained by the in-memory store. */
export const DEFAULT_IDEMPOTENCY_MAX_ENTRIES = 1_000;

/** Safe failures raised by key derivation and the local idempotency coordinator. */
export type IdempotencyErrorCode =
  | "invalid_key"
  | "invalid_configuration"
  | "conflict"
  | "store_unavailable";

/** Error whose message contains only a stable reason, never message content or a secret. */
export class IdempotencyError extends Error {
  /** Machine-readable reason safe to expose to callers. */
  readonly code: IdempotencyErrorCode;

  /**
   * Create an idempotency error.
   *
   * @param code - Stable reason without payload content.
   */
  constructor(code: IdempotencyErrorCode) {
    super(`idempotency-failed: ${code}`);
    this.name = "IdempotencyError";
    this.code = code;
  }
}

/** Inputs used to derive a stable key for one outbound message. */
export interface IdempotencyKeyInput {
  /** Validated outbound message used for content fallback. */
  message: OutboundMessage;
  /** Explicit caller-owned key, which takes precedence over derived values. */
  idempotency_key?: string;
  /** Stable inbound WAMID. */
  inbound_wamid?: string;
  /** Stable turn identifier paired with the inbound WAMID. */
  turn_id?: string;
}

/** A completed result persisted by an idempotency store. */
export interface IdempotencyEntry<T> {
  /** Key associated with the completed operation. */
  key: string;
  /** Hash of the semantic outbound request. */
  fingerprint: string;
  /** Result returned to every identical retry. */
  result: T;
  /** Absolute expiration time in epoch milliseconds. */
  expires_at_ms: number;
}

/** Values that may be returned synchronously or by a durable adapter. */
export type MaybePromise<T> = T | Promise<T>;

/** Minimal persistence port; a durable adapter can replace the in-memory default. */
export interface IdempotencyStore<T> {
  /** Read a completed result, or undefined when no live record exists. */
  get(key: string): MaybePromise<IdempotencyEntry<T> | undefined>;
  /** Persist one completed result. */
  set(entry: IdempotencyEntry<T>): MaybePromise<void>;
}

/** Naming alias for adapters that expose the idempotency store as a port. */
export type IdempotencyPort<T> = IdempotencyStore<T>;

/**
 * Derive a deterministic key from an explicit key, inbound identity, or content.
 *
 * Explicit keys are validated and returned unchanged. A WAMID plus turn ID is
 * preferred for replies. When neither is available, a canonical semantic
 * content hash is used, excluding routing and idempotency metadata.
 *
 * @param input - Message and optional identity metadata.
 * @returns A safe, stable key.
 * @throws IdempotencyError when metadata is malformed or serialization fails.
 */
export function derive_idempotency_key(input: IdempotencyKeyInput | OutboundMessage): string;
export function derive_idempotency_key(inbound_wamid: string, turn_id: string): string;
export function derive_idempotency_key(
  input_or_wamid: IdempotencyKeyInput | OutboundMessage | string,
  turn_id?: string,
): string {
  if (typeof input_or_wamid === "string") {
    const wamid = require_identity_token(input_or_wamid);
    const turn = require_identity_token(turn_id);
    return `wa:${hash(`${wamid}\u0000${turn}`)}`;
  }
  const normalized = normalize_key_input(input_or_wamid);
  if (normalized.idempotency_key !== undefined) return validate_idempotency_key(normalized.idempotency_key);
  if (normalized.turn_id !== undefined && normalized.inbound_wamid === undefined) {
    throw new IdempotencyError("invalid_key");
  }
  if (normalized.inbound_wamid !== undefined) {
    const wamid = require_identity_token(normalized.inbound_wamid);
    if (normalized.turn_id !== undefined) {
      const turn = require_identity_token(normalized.turn_id);
      return `wa:${hash(`${wamid}\u0000${turn}`)}`;
    }
    return `wa:content:${hash(`${wamid}\u0000${fingerprint_outbound_message(normalized.message)}`)}`;
  }
  return `wa:content:${fingerprint_outbound_message(normalized.message)}`;
}

/** Alias with a concise name for callers that already have a message. */
export const derive_key = derive_idempotency_key;

/**
 * Hash semantic outbound content for duplicate detection.
 *
 * @param message - Validated outbound message.
 * @returns A SHA-256 fingerprint that excludes routing metadata.
 * @throws IdempotencyError when the message cannot be serialized.
 */
export function fingerprint_outbound_message(message: OutboundMessage): string {
  const semantic = {
    to: message.to,
    type: message.type,
    text: message.text,
    template: message.template,
    buttons: message.buttons,
    interactive: message.interactive,
    requires_confirmation: message.requires_confirmation,
    is_state_changing: message.is_state_changing,
  };
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(canonicalize(semantic));
  } catch {
    throw new IdempotencyError("invalid_key");
  }
  if (typeof serialized !== "string") throw new IdempotencyError("invalid_key");
  return hash(serialized);
}

/** Alias retained for callers that use the shorter audit terminology. */
export const fingerprint_message = fingerprint_outbound_message;

/**
 * Validate a key without changing it.
 *
 * @param value - Candidate key.
 * @returns The original non-empty key.
 * @throws IdempotencyError when the key is not safe and bounded.
 */
export function validate_idempotency_key(value: unknown): string {
  if (!is_valid_idempotency_key(value)) throw new IdempotencyError("invalid_key");
  return value;
}

/** Non-throwing key predicate for boundary checks. */
export function is_valid_idempotency_key(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_IDEMPOTENCY_KEY_LENGTH &&
    value.trim() === value &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  );
}

interface NormalizedKeyInput extends IdempotencyKeyInput {
  message: OutboundMessage;
}

function normalize_key_input(input: IdempotencyKeyInput | OutboundMessage): NormalizedKeyInput {
  if (!is_record(input)) throw new IdempotencyError("invalid_key");
  if (is_outbound_message(input)) {
    return {
      message: input,
      idempotency_key: input.idempotency_key,
      inbound_wamid: input.inbound_wamid,
      turn_id: input.turn_id,
    };
  }
  if (!is_outbound_message(input.message)) throw new IdempotencyError("invalid_key");
  return {
    message: input.message,
    idempotency_key: input.idempotency_key,
    inbound_wamid: input.inbound_wamid,
    turn_id: input.turn_id,
  };
}

function is_outbound_message(value: unknown): value is OutboundMessage {
  return is_record(value) && (value.type === "text" || value.type === "template" || value.type === "interactive");
}

function require_identity_token(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_IDEMPOTENCY_KEY_LENGTH ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new IdempotencyError("invalid_key");
  }
  return value;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (is_record(value)) {
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) output[key] = canonicalize(value[key]);
    }
    return output;
  }
  return value;
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
