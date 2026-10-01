import { describe, expect, it } from "vitest";
import {
  consume_or_throw,
  InMemoryTenantRateLimiter,
  RateLimitExceededError,
} from "../src/rate_limit/tenant_rate_limiter.js";

 describe("tenant-aware rate limiting", () => {
  it("isolates tenants and scopes while enforcing a fixed window", async () => {
    let now_ms = 1_000_000;
    const limiter = new InMemoryTenantRateLimiter(() => now_ms);
    await expect(limiter.consume({ tenant_id: "42", scope: "webhook", limit: 2, window_seconds: 60 }))
      .resolves.toMatchObject({ allowed: true, remaining: 1 });
    await expect(limiter.consume({ tenant_id: "42", scope: "webhook", limit: 2, window_seconds: 60 }))
      .resolves.toMatchObject({ allowed: true, remaining: 0 });
    await expect(limiter.consume({ tenant_id: "42", scope: "webhook", limit: 2, window_seconds: 60 }))
      .resolves.toMatchObject({ allowed: false, remaining: 0 });
    await expect(limiter.consume({ tenant_id: "43", scope: "webhook", limit: 2, window_seconds: 60 }))
      .resolves.toMatchObject({ allowed: true, remaining: 1 });
    await expect(limiter.consume({ tenant_id: "42", scope: "outbound", limit: 2, window_seconds: 60 }))
      .resolves.toMatchObject({ allowed: true, remaining: 1 });
    now_ms += 60_001;
    await expect(limiter.consume({ tenant_id: "42", scope: "webhook", limit: 2, window_seconds: 60 }))
      .resolves.toMatchObject({ allowed: true, remaining: 1 });
  });

  it("throws a typed retryable denial and preserves the reset deadline", async () => {
    let now_ms = 2_000_000;
    const limiter = new InMemoryTenantRateLimiter(() => now_ms);
    await limiter.consume({ tenant_id: "42", scope: "outbound", limit: 1, window_seconds: 10 });
    await expect(consume_or_throw(limiter, {
      tenant_id: "42",
      scope: "outbound",
      limit: 1,
      window_seconds: 10,
    })).rejects.toBeInstanceOf(RateLimitExceededError);
    now_ms += 10_001;
    await expect(consume_or_throw(limiter, {
      tenant_id: "42",
      scope: "outbound",
      limit: 1,
      window_seconds: 10,
    })).resolves.toMatchObject({ allowed: true });
  });
});
