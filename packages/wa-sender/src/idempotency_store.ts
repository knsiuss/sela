import {
  DEFAULT_IDEMPOTENCY_MAX_ENTRIES,
  DEFAULT_IDEMPOTENCY_TTL_MS,
  IdempotencyError,
  type IdempotencyEntry,
  type IdempotencyStore,
} from "./idempotency.js";
import { is_valid_idempotency_key } from "./idempotency.js";

/** Constructor options for the bounded in-memory store. */
export interface InMemoryIdempotencyStoreOptions {
  /** Injectable epoch-millisecond clock. */
  clock?: () => number;
  /** Record lifetime in milliseconds. */
  ttl_ms?: number;
  /** Maximum retained record count. */
  max_entries?: number;
}

/** Bounded, expiring in-memory implementation of the idempotency port. */
export class InMemoryIdempotencyStore<T> implements IdempotencyStore<T> {
  private readonly entries = new Map<string, IdempotencyEntry<T>>();
  private readonly clock: () => number;
  private readonly ttl_ms: number;
  private readonly max_entries: number;

  /**
   * Create an in-memory store.
   *
   * @param options - Clock and retention limits.
   * @throws IdempotencyError when a retention limit is invalid.
   */
  constructor(options: InMemoryIdempotencyStoreOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.ttl_ms = positive_integer(options.ttl_ms, DEFAULT_IDEMPOTENCY_TTL_MS);
    this.max_entries = positive_integer(options.max_entries, DEFAULT_IDEMPOTENCY_MAX_ENTRIES);
    if (typeof this.clock !== "function") throw new IdempotencyError("invalid_configuration");
  }

  /**
   * Read a live record and remove it when expired.
   *
   * @param key - Validated idempotency key.
   * @returns A defensive record copy or undefined.
   */
  get(key: string): IdempotencyEntry<T> | undefined {
    const normalized_key = require_key(key);
    const entry = this.entries.get(normalized_key);
    if (entry === undefined) return undefined;
    if (entry.expires_at_ms <= this.read_clock()) {
      this.entries.delete(normalized_key);
      return undefined;
    }
    return { ...entry };
  }

  /**
   * Store a completed result and evict the oldest records when full.
   *
   * @param entry - Result record to retain.
   * @returns Nothing after the record is stored.
   */
  set(entry: IdempotencyEntry<T>): void {
    require_entry(entry);
    const existing = this.entries.get(entry.key);
    if (existing !== undefined) this.entries.delete(entry.key);
    this.entries.set(entry.key, { ...entry });
    while (this.entries.size > this.max_entries) {
      const oldest_key = this.entries.keys().next().value;
      if (typeof oldest_key !== "string") break;
      this.entries.delete(oldest_key);
    }
  }

  /** Remove all records, primarily for isolated tests and controlled shutdown. */
  clear(): void {
    this.entries.clear();
  }

  private read_clock(): number {
    const now_ms = this.clock();
    if (!Number.isFinite(now_ms)) throw new IdempotencyError("invalid_configuration");
    return now_ms;
  }
}

/** Backwards-friendly name for the small default cache. */
export class IdempotencyCache<T> extends InMemoryIdempotencyStore<T> {}

/** Explicit cache-name alias for callers that prefer the implementation name. */
export class InMemoryIdempotencyCache<T> extends InMemoryIdempotencyStore<T> {}

/** Options for the local single-flight coordinator. */
export interface IdempotencyCoordinatorOptions<T> {
  /** Optional durable or test store; defaults to a bounded in-memory store. */
  store?: IdempotencyStore<T>;
  /** Lifetime for newly completed results. */
  ttl_ms?: number;
  /** Clock used for expiration timestamps. */
  clock?: () => number;
  /** Maximum entries for the default in-memory store. */
  max_entries?: number;
}

/**
 * Coordinate one logical operation by key.
 *
 * A concurrent identical call shares the first operation's promise. A completed
 * identical call returns the cached result, while a different fingerprint fails
 * closed. Store failures are surfaced rather than bypassed because bypassing a
 * persistence failure could create a second external side effect.
 */
export class IdempotencyCoordinator<T> {
  private readonly store: IdempotencyStore<T>;
  private readonly clock: () => number;
  private readonly ttl_ms: number;
  private readonly in_flight = new Map<string, InFlightOperation<T>>();

  /**
   * Create a coordinator.
   *
   * @param options - Store and expiration settings.
   * @throws IdempotencyError when local configuration is invalid.
   */
  constructor(options: IdempotencyCoordinatorOptions<T> = {}) {
    this.clock = options.clock ?? Date.now;
    if (typeof this.clock !== "function") throw new IdempotencyError("invalid_configuration");
    this.ttl_ms = positive_integer(options.ttl_ms, DEFAULT_IDEMPOTENCY_TTL_MS);
    this.store =
      options.store ??
      new InMemoryIdempotencyStore<T>({
        clock: this.clock,
        ttl_ms: this.ttl_ms,
        max_entries: options.max_entries,
      });
  }

  /**
   * Execute an operation once for a key.
   *
   * @param key - Caller or derived key.
   * @param fingerprint - Hash of semantic request content.
   * @param operation - Side-effecting operation to run at most once locally.
   * @returns The first or cached result.
   * @throws IdempotencyError for invalid keys, conflicts, and store failures.
   */
  async execute(key: string, fingerprint: string, operation: () => T | Promise<T>): Promise<T> {
    const normalized_key = require_key(key);
    const normalized_fingerprint = require_fingerprint(fingerprint);
    const active = this.in_flight.get(normalized_key);
    if (active !== undefined) {
      if (active.fingerprint !== normalized_fingerprint) throw new IdempotencyError("conflict");
      return active.promise;
    }
    const promise = this.execute_once(normalized_key, normalized_fingerprint, operation).finally(() => {
      const current = this.in_flight.get(normalized_key);
      if (current?.promise === promise) this.in_flight.delete(normalized_key);
    });
    this.in_flight.set(normalized_key, { fingerprint: normalized_fingerprint, promise });
    return promise;
  }

  private async execute_once(key: string, fingerprint: string, operation: () => T | Promise<T>): Promise<T> {
    const cached = await this.read_cache(key);
    if (cached !== undefined) {
      if (cached.fingerprint !== fingerprint) throw new IdempotencyError("conflict");
      return cached.result;
    }
    const result = await operation();
    if (result === undefined) throw new IdempotencyError("store_unavailable");
    try {
      await this.store.set({ key, fingerprint, result, expires_at_ms: this.read_clock() + this.ttl_ms });
    } catch {
      throw new IdempotencyError("store_unavailable");
    }
    return result;
  }

  private async read_cache(key: string): Promise<IdempotencyEntry<T> | undefined> {
    try {
      const entry = await this.store.get(key);
      if (entry === undefined) return undefined;
      require_entry(entry);
      if (entry.key !== key) throw new IdempotencyError("store_unavailable");
      if (entry.expires_at_ms <= this.read_clock()) return undefined;
      return entry;
    } catch (error) {
      if (error instanceof IdempotencyError) throw error;
      throw new IdempotencyError("store_unavailable");
    }
  }

  private read_clock(): number {
    const now_ms = this.clock();
    if (!Number.isFinite(now_ms)) throw new IdempotencyError("invalid_configuration");
    return now_ms;
  }
}

interface InFlightOperation<T> {
  fingerprint: string;
  promise: Promise<T>;
}

function require_key(value: unknown): string {
  if (!is_valid_idempotency_key(value)) throw new IdempotencyError("invalid_key");
  return value;
}

function require_fingerprint(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new IdempotencyError("invalid_key");
  }
  return value;
}

function require_entry<T>(entry: IdempotencyEntry<T>): void {
  if (
    !is_record(entry) ||
    typeof entry.key !== "string" ||
    typeof entry.fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/u.test(entry.fingerprint) ||
    typeof entry.expires_at_ms !== "number" ||
    !Number.isFinite(entry.expires_at_ms) ||
    entry.result === undefined
  ) {
    throw new IdempotencyError("store_unavailable");
  }
  require_key(entry.key);
}

function positive_integer(value: number | undefined, default_value: number): number {
  if (value === undefined) return default_value;
  if (!Number.isSafeInteger(value) || value <= 0) throw new IdempotencyError("invalid_configuration");
  return value;
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
