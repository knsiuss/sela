import { describe, expect, it, vi } from "vitest";
import { handle_operator_action } from "../src/http/operator_api.js";
import { InMemoryOperatorActionAudit, OperatorActionService } from "../src/enterprise/operator_actions.js";
import { parse_authenticated_principal } from "../src/enterprise/authorization.js";
import { InMemoryTenantRateLimiter } from "../src/rate_limit/tenant_rate_limiter.js";

const principal = parse_authenticated_principal({
  subject_id: "operator-1",
  session_id: "session-1",
  has_mfa: true,
  issued_at_iso: "2026-09-25T00:00:00.000Z",
  tenant_roles: { "42": ["admin"] },
});

describe("versioned operator API", () => {
  it("requires a verified bearer token and audits an authorized action", async () => {
    const audit = new InMemoryOperatorActionAudit();
    const service = new OperatorActionService(audit, vi.fn(async () => undefined));
    const options = {
      verifier: { verify: vi.fn(async () => principal) },
      service,
    };
    const body = JSON.stringify({
      tenant_id: "42",
      action: "export_audit",
      target_id: "tenant-42",
      reason: "approved support review",
    });
    await expect(handle_operator_action("POST", "/v1/operator/actions", {}, body, options))
      .resolves.toMatchObject({ status: 401 });
    await expect(handle_operator_action(
      "POST",
      "/v1/operator/actions",
      { authorization: "Bearer test-token" },
      body,
      options,
    )).resolves.toMatchObject({ status: 200, body: { outcome: "succeeded" } });
    expect(audit.records).toHaveLength(1);
  });

  it("applies a tenant limit before invoking an operator side effect", async () => {
    const audit = new InMemoryOperatorActionAudit();
    const handler = vi.fn(async () => undefined);
    const service = new OperatorActionService(audit, handler);
    const options = {
      verifier: { verify: vi.fn(async () => principal) },
      service,
      rate_limiter: new InMemoryTenantRateLimiter(() => 1_000),
      operator_limit: 1,
      operator_window_seconds: 60,
    };
    const body = JSON.stringify({ tenant_id: "42", action: "export_audit", target_id: "tenant-42", reason: "review" });
    await expect(handle_operator_action("POST", "/v1/operator/actions", { authorization: "Bearer token" }, body, options))
      .resolves.toMatchObject({ status: 200 });
    await expect(handle_operator_action("POST", "/v1/operator/actions", { authorization: "Bearer token" }, body, options))
      .resolves.toMatchObject({ status: 429 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("rejects a cross-tenant action before consuming the target limiter", async () => {
    const audit = new InMemoryOperatorActionAudit();
    const handler = vi.fn(async () => undefined);
    const consume = vi.fn(async () => ({
      allowed: true,
      limit: 60,
      remaining: 59,
      reset_at_iso: "2026-09-25T00:01:00.000Z",
      retry_after_seconds: 60,
    }));
    const service = new OperatorActionService(audit, handler);
    const options = {
      verifier: { verify: vi.fn(async () => principal) },
      service,
      rate_limiter: { consume },
    };
    const body = JSON.stringify({ tenant_id: "43", action: "replay_outbound", target_id: "outbound-43", reason: "review" });

    await expect(handle_operator_action("POST", "/v1/operator/actions", { authorization: "Bearer token" }, body, options))
      .resolves.toMatchObject({ status: 403, body: { error: "forbidden" } });
    expect(consume).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({ tenant_id: "43", outcome: "denied" });
  });

  it("rejects a privileged action without MFA before consuming the tenant limiter", async () => {
    const audit = new InMemoryOperatorActionAudit();
    const handler = vi.fn(async () => undefined);
    const consume = vi.fn(async () => ({
      allowed: true,
      limit: 60,
      remaining: 59,
      reset_at_iso: "2026-09-25T00:01:00.000Z",
      retry_after_seconds: 60,
    }));
    const no_mfa_principal = parse_authenticated_principal({
      subject_id: "operator-1",
      session_id: "session-1",
      has_mfa: false,
      issued_at_iso: "2026-09-25T00:00:00.000Z",
      tenant_roles: { "42": ["admin"] },
    });
    const service = new OperatorActionService(audit, handler);
    const options = {
      verifier: { verify: vi.fn(async () => no_mfa_principal) },
      service,
      rate_limiter: { consume },
    };
    const body = JSON.stringify({ tenant_id: "42", action: "replay_outbound", target_id: "outbound-42", reason: "review" });

    await expect(handle_operator_action("POST", "/v1/operator/actions", { authorization: "Bearer token" }, body, options))
      .resolves.toMatchObject({ status: 403, body: { error: "mfa_required" } });
    expect(consume).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(audit.records[0]).toMatchObject({ outcome: "denied", reason_code: "authorization_denied" });
  });
});
