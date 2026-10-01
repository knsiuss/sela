/** Tenant-scoped fixed-window admission control for public and provider work. */

import type { SqlClient, SqlQueryResult } from "../persistence/sql_client.js";

/** Admission scopes kept deliberately small to avoid label/cardinality abuse. */
export type RateLimitScope = "webhook" | "outbound" | "operator";

/** One bounded tenant admission decision. */
export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  reset_at_iso: string;
  retry_after_seconds: number;
}

/** Input for one tenant-scoped admission attempt. */
export interface RateLimitRequest {
  tenant_id: string;
  scope: RateLimitScope;
  limit: number;
  window_seconds: number;
}

/** Port consumed by ingress and outbound boundaries. */
export interface TenantRateLimiter {
  /** Consume one unit or return a retryable denial. */
  consume(request: RateLimitRequest): Promise<RateLimitDecision>;
}

/** Safe failure raised when a configured limit is exhausted. */
export class RateLimitExceededError extends Error {
  readonly code = "rate_limit_exceeded";
  readonly retry_at: Date;

  /** Create a sanitized rate-limit response. */
  constructor(readonly decision: RateLimitDecision) {
    super("rate-limit-exceeded");
    this.name = "RateLimitExceededError";
    this.retry_at = new Date(decision.reset_at_iso);
  }
}

/** Safe failure for an unavailable durable limiter. */
export class RateLimiterUnavailableError extends Error {
  readonly code = "rate_limiter_unavailable";

  /** Create a sanitized persistence failure. */
  constructor(cause?: unknown) {
    super("rate-limiter-unavailable", cause === undefined ? undefined : { cause });
    this.name = "RateLimiterUnavailableError";
  }
}

interface MemoryWindow {
  count: number;
  reset_at_ms: number;
}

/** Explicit process-local limiter for local mode and deterministic tests. */
export class InMemoryTenantRateLimiter implements TenantRateLimiter {
  private readonly windows = new Map<string, MemoryWindow>();
  private readonly clock: () => number;

  /** Create an isolated limiter with an injectable clock. */
  constructor(clock: () => number = Date.now) {
    this.clock = clock;
  }

  /** Consume a fixed-window unit without blocking other tenants. */
  async consume(request: RateLimitRequest): Promise<RateLimitDecision> {
    const normalized = validate_request(request);
    const now_ms = this.clock();
    const bucket = Math.floor(now_ms / (normalized.window_seconds * 1_000));
    const reset_at_ms = (bucket + 1) * normalized.window_seconds * 1_000;
    const key = `${normalized.tenant_id}\u0000${normalized.scope}\u0000${bucket}`;
    const current = this.windows.get(key);
    const count = (current?.count ?? 0) + 1;
    this.windows.set(key, { count, reset_at_ms });
    this.prune(now_ms);
    return decision(normalized, count, reset_at_ms, now_ms);
  }

  private prune(now_ms: number): void {
    for (const [key, window] of this.windows) {
      if (window.reset_at_ms <= now_ms) this.windows.delete(key);
    }
  }
}

const CONSUME_WINDOW_SQL = `
  INSERT INTO public.tenant_rate_limits (
    tenant_id, scope, window_bucket, request_count, limit_count, window_seconds
  )
  VALUES (
    $1, $2, $3, 1, $4, $5
  )
  ON CONFLICT (tenant_id, scope, window_bucket) DO UPDATE
  SET request_count = public.tenant_rate_limits.request_count + 1,
      limit_count = EXCLUDED.limit_count,
      window_seconds = EXCLUDED.window_seconds,
      updated_at = now()
  RETURNING request_count, limit_count, window_seconds, window_bucket
`;

/** Atomic Postgres-backed limiter suitable for multiple API/worker replicas. */
export class PostgresTenantRateLimiter implements TenantRateLimiter {
  private readonly sql_client: SqlClient;
  private readonly clock: () => number;

  /** Create a limiter over the server-side SQL boundary. */
  constructor(sql_client: SqlClient, clock: () => number = Date.now) {
    this.sql_client = sql_client;
    this.clock = clock;
  }

  /** Consume one unit using an atomic upsert. */
  async consume(request: RateLimitRequest): Promise<RateLimitDecision> {
    const normalized = validate_request(request);
    if (!/^[1-9]\d{0,18}$/.test(normalized.tenant_id)) {
      throw new RateLimiterUnavailableError(new Error("rate-limit-tenant-invalid"));
    }
    const bucket = Math.floor(this.clock() / (normalized.window_seconds * 1_000));
    try {
      const result = await this.sql_client.query(CONSUME_WINDOW_SQL, [
        normalized.tenant_id,
        normalized.scope,
        bucket,
        normalized.limit,
        normalized.window_seconds,
      ]);
      return parse_decision(result, normalized, this.clock());
    } catch (error) {
      if (error instanceof RateLimiterUnavailableError) throw error;
      throw new RateLimiterUnavailableError(error);
    }
  }
}

/** Consume and throw a typed denial when the limit is exhausted. */
export async function consume_or_throw(
  limiter: TenantRateLimiter,
  request: RateLimitRequest,
): Promise<RateLimitDecision> {
  const result = await limiter.consume(request);
  if (!result.allowed) throw new RateLimitExceededError(result);
  return result;
}

function decision(
  request: RateLimitRequest,
  count: number,
  reset_at_ms: number,
  now_ms: number,
): RateLimitDecision {
  const remaining = Math.max(0, request.limit - count);
  const retry_after_seconds = Math.max(1, Math.ceil((reset_at_ms - now_ms) / 1_000));
  return {
    allowed: count <= request.limit,
    limit: request.limit,
    remaining,
    reset_at_iso: new Date(reset_at_ms).toISOString(),
    retry_after_seconds,
  };
}

function parse_decision(
  result: SqlQueryResult,
  request: RateLimitRequest,
  now_ms: number,
): RateLimitDecision {
  if (!Array.isArray(result.rows) || result.rows.length !== 1) {
    throw new RateLimiterUnavailableError();
  }
  const row = result.rows[0];
  if (typeof row !== "object" || row === null) throw new RateLimiterUnavailableError();
  const record = row as Record<string, unknown>;
  const count = safe_integer(record.request_count, "request_count");
  const limit = safe_integer(record.limit_count, "limit_count");
  const window_seconds = safe_integer(record.window_seconds, "window_seconds");
  const bucket = safe_integer(record.window_bucket, "window_bucket");
  if (count < 1 || limit < 1 || window_seconds < 1 || window_seconds > 86_400) {
    throw new RateLimiterUnavailableError();
  }
  const reset_at_ms = (bucket + 1) * window_seconds * 1_000;
  const normalized = { ...request, limit };
  return decision(normalized, count, reset_at_ms, now_ms);
}

function safe_integer(value: unknown, field_name: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new RateLimiterUnavailableError(`rate-limit-${field_name}-invalid`);
  return parsed;
}

function validate_request(value: RateLimitRequest): RateLimitRequest {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.tenant_id !== "string" ||
    value.tenant_id.length < 1 ||
    value.tenant_id.length > 256 ||
    value.tenant_id.trim() !== value.tenant_id ||
    /[\u0000-\u001f\u007f]/u.test(value.tenant_id) ||
    (value.scope !== "webhook" && value.scope !== "outbound" && value.scope !== "operator") ||
    !Number.isSafeInteger(value.limit) ||
    value.limit < 1 ||
    value.limit > 100_000 ||
    !Number.isSafeInteger(value.window_seconds) ||
    value.window_seconds < 1 ||
    value.window_seconds > 86_400
  ) {
    throw new TypeError("rate-limit-request-invalid");
  }
  return {
    tenant_id: value.tenant_id,
    scope: value.scope,
    limit: value.limit,
    window_seconds: value.window_seconds,
  };
}
