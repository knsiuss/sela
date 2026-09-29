import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DATA_RETENTION_POLICY,
  InMemoryDataLifecycleStore,
  PostgresDataLifecycleStore,
  anonymize_for_analytics,
  redact_inbound_for_operator,
  retention_policy_statement,
} from "../src/enterprise/data_lifecycle.js";
import { run_retention_purge } from "../src/enterprise/retention_runner.js";
import { MetricsRegistry } from "../src/observability/metrics.js";
import type { SqlClient, SqlQueryResult } from "../src/persistence/sql_client.js";

const POLICY = { inbound_days: 30, outbound_days: 90, rate_limit_bucket_days: 2 };

function seeded_store(): InMemoryDataLifecycleStore {
  const store = new InMemoryDataLifecycleStore();
  store.seed({
    inbound: 3,
    sessions: 2,
    jobs_terminal_unclaimed: 2,
    jobs_terminal_claimed: 1,
    jobs_active: 1,
    outbound: 2,
    rate_limit_buckets: 2,
    dedupe_claims: 4,
  });
  return store;
}

describe("retention purge lifecycle", () => {
  it("purges expired sessions and unclaimed terminal jobs while preserving claims", async () => {
    const store = seeded_store();
    const deleted = await store.purge_expired(POLICY, 20);
    expect(deleted).toEqual({
      inbound_deleted: 3,
      sessions_deleted: 2,
      jobs_deleted: 2,
      outbound_deleted: 2,
      rate_limit_buckets_deleted: 2,
    });
    expect(store.retained_counts()).toEqual({ jobs_active: 1, jobs_terminal_claimed: 1, dedupe_claims: 4 });
    const second = await store.purge_expired(POLICY, 20);
    expect(second).toEqual({
      inbound_deleted: 0,
      sessions_deleted: 0,
      jobs_deleted: 0,
      outbound_deleted: 0,
      rate_limit_buckets_deleted: 0,
    });
  });

  it("applies the shared bound across categories in purge order", async () => {
    const store = seeded_store();
    const deleted = await store.purge_expired(POLICY, 4);
    expect(deleted.inbound_deleted).toBe(3);
    expect(deleted.sessions_deleted).toBe(1);
    expect(deleted.jobs_deleted).toBe(0);
  });

  it("suppresses session and job purge under a tenant hold until release", async () => {
    const store = seeded_store();
    await store.set_legal_hold({ tenant_id: "42", scope: "tenant", reference: "matter-1", reason_code: "legal_request" });
    const held = await store.purge_expired(POLICY, 20);
    expect(held).toEqual({
      inbound_deleted: 0,
      sessions_deleted: 0,
      jobs_deleted: 0,
      outbound_deleted: 0,
      rate_limit_buckets_deleted: 0,
    });
    await store.release_legal_hold("42", "tenant", "matter-1");
    const released = await store.purge_expired(POLICY, 20);
    expect(released.sessions_deleted).toBe(2);
    expect(released.jobs_deleted).toBe(2);
  });

  it("suppresses only inbound purge under an inbound-scoped hold", async () => {
    const store = seeded_store();
    await store.set_legal_hold({ tenant_id: "42", scope: "inbound", reference: "matter-2", reason_code: "legal_request" });
    const held = await store.purge_expired(POLICY, 20);
    expect(held.inbound_deleted).toBe(0);
    expect(held.sessions_deleted).toBe(2);
    expect(held.jobs_deleted).toBe(2);
    expect(held.outbound_deleted).toBe(2);
  });

  it("previews eligible rows without mutating state", async () => {
    const store = seeded_store();
    const preview = await store.preview_expired(POLICY, 20);
    expect(preview.sessions_deleted).toBe(2);
    expect(preview.jobs_deleted).toBe(2);
    const after = await store.preview_expired(POLICY, 20);
    expect(after).toEqual(preview);
  });
});

describe("retention purge runner", () => {
  it("supports dry runs with metrics and structured events but no mutation", async () => {
    const store = seeded_store();
    const metrics = new MetricsRegistry();
    const events: unknown[] = [];
    const preview = await run_retention_purge(store, POLICY, {
      limit: 20,
      dry_run: true,
      metrics,
      events: (event) => events.push(event),
      clock: () => 1_000,
    });
    expect(preview.dry_run).toBe(true);
    expect(preview.deleted.sessions_deleted).toBe(2);
    expect(metrics.counter_value("retention_purge_runs_total", { outcome: "completed", dry_run: "true" })).toBe(1);
    expect(metrics.counter_value("retention_purged_total", { category: "sessions", dry_run: "true" })).toBe(2);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: "retention_purge", dry_run: true, outcome: "completed" });
    const after = await store.preview_expired(POLICY, 20);
    expect(after.sessions_deleted).toBe(2);
  });

  it("records real purges without leaking tenant or content data", async () => {
    const store = seeded_store();
    const metrics = new MetricsRegistry();
    const events: unknown[] = [];
    const result = await run_retention_purge(store, POLICY, {
      limit: 20,
      dry_run: false,
      metrics,
      events: (event) => events.push(event),
    });
    expect(result.deleted.jobs_deleted).toBe(2);
    expect(metrics.counter_value("retention_purged_total", { category: "jobs", dry_run: "false" })).toBe(2);
    expect(JSON.stringify(events)).not.toContain("private");
    expect(events[0]).toMatchObject({ event: "retention_purge", dry_run: false, outcome: "completed" });
  });

  it("reports failures through metrics and events before rethrowing", async () => {
    const failing: InMemoryDataLifecycleStore = seeded_store();
    failing.purge_expired = async () => {
      throw new PurgeBoomError();
    };
    const metrics = new MetricsRegistry();
    const events: unknown[] = [];
    await expect(run_retention_purge(failing, POLICY, {
      limit: 5,
      dry_run: false,
      metrics,
      events: (event) => events.push(event),
    })).rejects.toBeInstanceOf(PurgeBoomError);
    expect(metrics.counter_value("retention_purge_runs_total", { outcome: "failed", dry_run: "false" })).toBe(1);
    expect(events[0]).toMatchObject({ event: "retention_purge", outcome: "failed", error_code: "purgeboomerror" });
  });

  it("rejects invalid runner options without touching the store", async () => {
    const store = seeded_store();
    const preview = vi.spyOn(store, "preview_expired");
    await expect(run_retention_purge(store, POLICY, { limit: 5, dry_run: "yes" as unknown as boolean }))
      .rejects.toThrow("retention-purge-dry-run-invalid");
    expect(preview).not.toHaveBeenCalled();
  });
});

describe("postgres lifecycle SQL contracts", () => {
  it("purges sessions and detached terminal jobs with hold and claim guards", async () => {
    const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
    const handler = (sql: string, values?: readonly unknown[]): SqlQueryResult => {
      calls.push({ sql, values });
      if (sql.includes("DELETE FROM public.reschedule_sessions")) return { rows: [{ id: 1 }] };
      if (sql.includes("DELETE FROM public.webhook_jobs")) return { rows: [{ id: 7 }] };
      return { rows: [] };
    };
    const client: SqlClient = { query: async (sql, values) => handler(sql, values) };
    const store = new PostgresDataLifecycleStore(client);
    const deleted = await store.purge_expired({ ...POLICY, job_days: 45 }, 10);
    expect(deleted.sessions_deleted).toBe(1);
    expect(deleted.jobs_deleted).toBe(1);
    const sessions_sql = calls.find((call) => call.sql.includes("reschedule_sessions"))?.sql ?? "";
    expect(sessions_sql).toContain("expires_at <= now()");
    expect(sessions_sql).toContain("legal_holds");
    const jobs_sql = calls.find((call) => call.sql.includes("webhook_jobs"))?.sql ?? "";
    expect(jobs_sql).toContain("processed_messages");
    expect(jobs_sql).toContain("'completed'");
    expect(jobs_sql).toContain("'failed'");
    expect(jobs_sql).toContain("legal_holds");
    expect(jobs_sql).not.toContain("pending");
    const jobs_values = calls.find((call) => call.sql.includes("webhook_jobs"))?.values;
    expect(jobs_values?.[1]).toBe(45);
    const touched = calls.map((call) => call.sql).join("\n");
    expect(touched).not.toContain("audit_log");
    expect(touched).not.toContain("operator_action_audit");
    expect(touched).not.toContain("ingress_repairs");
  });

  it("previews eligibility with the same hold, claim, and TTL predicates", async () => {
    const seen: string[] = [];
    const client: SqlClient = {
      query: async (sql, values) => {
        seen.push(sql);
        expect(values).toEqual([45, 90, 2]);
        return {
          rows: [{
            inbound_eligible: "2",
            sessions_eligible: "1",
            jobs_eligible: "3",
            outbound_eligible: "0",
            rate_limit_buckets_eligible: "0",
          }],
        };
      },
    };
    const store = new PostgresDataLifecycleStore(client);
    const preview = await store.preview_expired({ ...POLICY, job_days: 45 }, 4);
    expect(preview).toEqual({
      inbound_deleted: 2,
      sessions_deleted: 1,
      jobs_deleted: 1,
      outbound_deleted: 0,
      rate_limit_buckets_deleted: 0,
    });
    expect(seen.join("\n")).toContain("processed_messages");
  });
});

describe("privacy views and policy", () => {
  it("exposes named tunable defaults for every category", () => {
    expect(DEFAULT_DATA_RETENTION_POLICY).toMatchObject({
      inbound_days: 30,
      session_days: 7,
      job_days: 90,
      outbound_days: 90,
      audit_days: 365,
      rate_limit_bucket_days: 2,
    });
  });

  it("renders quotable retention sentences for a future privacy policy", () => {
    const lines = retention_policy_statement(DEFAULT_DATA_RETENTION_POLICY);
    const joined = lines.join("\n");
    expect(joined).toContain("30 days");
    expect(joined).toContain("7 days");
    expect(joined).toContain("365 days");
    expect(joined).toContain("legal hold");
    expect(joined).toContain("Idempotency claims are never deleted");
  });

  it("anonymizes analytics events without raw content or PII", () => {
    const event = anonymize_for_analytics({
      tenant_id: "42",
      action: "appointment_rescheduled",
      outcome: "confirmed",
      sender_ref: "opaque-sender-1",
      message_text: "private message content",
      conversation_id: "conversation-1",
    });
    expect(event.message_length_bucket).toBe("short");
    expect(event.sender_ref_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(event.message_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(event)).not.toContain("private message content");
    expect(JSON.stringify(event)).not.toContain("opaque-sender-1");
    expect(JSON.stringify(event)).not.toContain("conversation-1");
    const redacted = redact_inbound_for_operator({
      tenant_id: "42",
      wamid: "wamid-1",
      sender_ref: "opaque-sender",
      message_text: "private message",
    });
    expect(JSON.stringify(redacted)).not.toContain("private message");
  });

  it("rejects unbounded analytics codes fail-fast", async () => {
    expect(() => anonymize_for_analytics({ tenant_id: "42", action: "Bad Action!", outcome: "ok" }))
      .toThrow("analytics-action-invalid");
    expect(() => anonymize_for_analytics({ tenant_id: "", action: "ok", outcome: "ok" }))
      .toThrow("analytics-tenant-invalid");
  });
});

class PurgeBoomError extends Error {
  constructor() {
    super("purge-boom");
    this.name = "PurgeBoomError";
  }
}
