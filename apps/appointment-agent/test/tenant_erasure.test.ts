import { describe, expect, it } from "vitest";
import {
  TenantErasureBlockedError,
  TenantErasureError,
  build_tenant_export,
  erase_tenant,
  evict_tenant_caches,
  type ErasureAuditSink,
  type TenantCacheEvictor,
  type TenantErasureEvent,
} from "../src/enterprise/tenant_erasure.js";
import { InMemoryTenantErasureStore, PostgresTenantErasureStore } from "../src/enterprise/tenant_erasure_store.js";
import { InMemoryInboundMessageStore } from "../src/ingress/inbound_store.js";
import { InMemoryMessageDedupe } from "../src/ingress/dedupe.js";
import { InMemoryRescheduleSessionStore } from "../src/reschedule/session_store.js";
import { TenantSecretSenderRegistry } from "../src/outbound/tenant_sender_registry.js";
import { TenantSenderCredentialStore } from "../src/security/tenant_sender_credentials.js";
import { MetricsRegistry } from "../src/observability/metrics.js";
import type { SqlClient, SqlQueryResult } from "../src/persistence/sql_client.js";

const FIXED_DATE = new Date("2026-09-29T00:00:00.000Z");

function seeded_store(): InMemoryTenantErasureStore {
  const store = new InMemoryTenantErasureStore();
  store.seed_tenant("42", {
    inbound_messages: 5,
    reschedule_sessions: 2,
    jobs_active: 3,
    jobs_terminal: 4,
    outbound_records: 6,
    dedupe_claims: 7,
    audit_records: 8,
    rate_limit_buckets: 2,
  });
  store.seed_tenant("43", { inbound_messages: 1 });
  return store;
}

function recording_evictor(): TenantCacheEvictor & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    evict_tenant: async (tenant_id: string) => {
      calls.push(tenant_id);
    },
  };
}

function recording_audit(): ErasureAuditSink & { records: unknown[] } {
  const records: unknown[] = [];
  return {
    records,
    record_erasure: async (input) => {
      records.push({ ...input });
    },
  };
}

describe("tenant quarantine erasure", () => {
  it("deletes content while preserving terminal, evidence, and other tenants", async () => {
    const store = seeded_store();
    const evictor = recording_evictor();
    const audit = recording_audit();
    const events: TenantErasureEvent[] = [];
    const metrics = new MetricsRegistry();
    const result = await erase_tenant(store, "42", {
      mode: "quarantine",
      evictors: [evictor],
      audit,
      actor_subject: "operator-1",
      request_id: "request-1",
      metrics,
      events: (event) => events.push(event),
      clock: () => FIXED_DATE,
    });
    expect(result.deletion).toMatchObject({
      mode: "quarantine",
      tenant_removed: false,
      deleted: {
        inbound_messages: 5,
        reschedule_sessions: 2,
        jobs: 3,
        rate_limit_buckets: 2,
        outbound_records: 0,
        dedupe_claims: 0,
        audit_records: 0,
      },
      preserved: { dedupe_claims: 7, terminal_jobs: 4, outbound_records: 6, audit_records: 8 },
    });
    expect(store.tenant_counts("42")).toMatchObject({
      inbound_messages: 0,
      reschedule_sessions: 0,
      jobs_active: 0,
      jobs_terminal: 4,
      outbound_records: 6,
      dedupe_claims: 7,
      audit_records: 8,
    });
    expect(store.tenant_counts("43")).toMatchObject({ inbound_messages: 1 });
    expect(evictor.calls).toEqual(["42"]);
    expect(result.evicted_caches).toBe(1);
    expect(audit.records).toEqual([{
      tenant_id: "42",
      mode: "quarantine",
      outcome: "completed",
      reason_code: "tenant_erasure_quarantined",
      request_id: "request-1",
      actor_subject: "operator-1",
    }]);
    expect(events[0]).toMatchObject({ event: "tenant_erasure", mode: "quarantine", outcome: "completed" });
    expect(metrics.counter_value("tenant_erasure_runs_total", { mode: "quarantine", outcome: "completed" })).toBe(1);
  });

  it("asserts the customer export shape with counts and no content or PII", async () => {
    const store = seeded_store();
    const result = await erase_tenant(store, "42", { mode: "quarantine", evictors: [] });
    expect(result.export).toMatchObject({
      tenant_id: "42",
      counts: {
        inbound_messages: 5,
        reschedule_sessions: 2,
        jobs_active: 3,
        jobs_terminal: 4,
        outbound_records: 6,
        dedupe_claims: 7,
        audit_records: 8,
        rate_limit_buckets: 2,
      },
      active_legal_holds: [],
    });
    expect(typeof result.export.exported_at_iso).toBe("string");
    expect(result.export.retention_policy_statement.length).toBeGreaterThan(5);
    expect(result.export.note).toContain("never included");
    const serialized = JSON.stringify(result.export);
    expect(serialized).not.toContain("private");
    expect(Object.keys(result.export).sort()).toEqual(
      ["active_legal_holds", "counts", "exported_at_iso", "note", "retention_policy_statement", "tenant_id"].sort(),
    );
  });

  it("blocks quarantine under a tenant hold and audits the denial", async () => {
    const store = seeded_store();
    store.set_hold("42", "tenant", "matter-1");
    const audit = recording_audit();
    const events: TenantErasureEvent[] = [];
    await expect(erase_tenant(store, "42", {
      mode: "quarantine",
      evictors: [recording_evictor()],
      audit,
      actor_subject: "operator-1",
      request_id: "request-2",
      events: (event) => events.push(event),
    })).rejects.toMatchObject({ name: "TenantErasureBlockedError", reason: "legal-hold-tenant" });
    expect(store.tenant_counts("42")).toMatchObject({ inbound_messages: 5 });
    expect(audit.records[0]).toMatchObject({ outcome: "blocked", reason_code: "legal_hold_tenant" });
    expect(events[0]).toMatchObject({ outcome: "blocked", error_code: "legal-hold-tenant" });
  });

  it("allows quarantine under an audit-scoped hold but blocks cascade", async () => {
    const store = seeded_store();
    store.set_hold("42", "audit", "matter-2");
    const quarantined = await erase_tenant(store, "42", { mode: "quarantine", evictors: [] });
    expect(quarantined.deletion.mode).toBe("quarantine");
    await expect(erase_tenant(seeded_store_with_audit_hold(), "42", { mode: "cascade", evictors: [] }))
      .rejects.toMatchObject({ name: "TenantErasureBlockedError", reason: "legal-hold-audit" });
  });

  it("removes the tenant row and all content in cascade mode", async () => {
    const store = seeded_store();
    const result = await erase_tenant(store, "42", { mode: "cascade", evictors: [] });
    expect(result.deletion.tenant_removed).toBe(true);
    expect(result.deletion.deleted).toMatchObject({
      inbound_messages: 5,
      reschedule_sessions: 2,
      jobs: 7,
      outbound_records: 6,
      dedupe_claims: 7,
      audit_records: 8,
    });
    expect(result.deletion.preserved).toEqual({ dedupe_claims: 0, terminal_jobs: 0, outbound_records: 0, audit_records: 0 });
    expect(store.tenant_counts("42")).toBeNull();
    expect(store.tenant_counts("43")).toMatchObject({ inbound_messages: 1 });
  });

  it("rejects invalid tenants, modes, and unaudited destructive calls", async () => {
    const store = seeded_store();
    await expect(erase_tenant(store, "", { mode: "quarantine", evictors: [] }))
      .rejects.toThrow("tenant-erasure-tenant-invalid");
    await expect(erase_tenant(store, "42", { mode: "purge" as never, evictors: [] }))
      .rejects.toThrow("tenant-erasure-mode-invalid");
    await expect(erase_tenant(store, "42", { mode: "quarantine", evictors: [], audit: recording_audit() }))
      .rejects.toThrow("tenant-erasure-actor-invalid");
  });
});

describe("tenant cache eviction", () => {
  it("runs every evictor so no cache is silently skipped", async () => {
    const first = recording_evictor();
    const failing: TenantCacheEvictor = {
      evict_tenant: async () => {
        throw new Error("cache-unavailable");
      },
    };
    const last = recording_evictor();
    await expect(evict_tenant_caches([first, failing, last], "42"))
      .rejects.toBeInstanceOf(TenantErasureError);
    expect(first.calls).toEqual(["42"]);
    expect(last.calls).toEqual(["42"]);
  });

  it("removes deleted tenant data from in-memory content stores", async () => {
    const inbound = new InMemoryInboundMessageStore();
    await inbound.save({
      tenant_id: "42",
      wamid: "wamid-evict-1",
      conversation_id: "conversation-1",
      message_type: "text",
      button_id: null,
      sender_ref: "sender-1",
      reply_target_ciphertext: "ciphertext-1",
      message_text: "hello",
      received_at: "2026-09-28T00:00:00.000Z",
      expires_at: "2026-10-28T00:00:00.000Z",
      processed_at: null,
    });
    const sessions = new InMemoryRescheduleSessionStore();
    await sessions.commit(
      { tenant_id: "42", conversation_id: "conversation-1" },
      {
        phase: "offered",
        appointment_id: null,
        source_appointment_version: null,
        candidate_slots: [],
        chosen_slot_id: null,
        hold_id: null,
        hold_expires_at_iso: null,
        offer_generation: 1,
        last_wamid: null,
        expires_at_iso: "2026-10-28T00:00:00.000Z",
      },
      null,
    );
    const dedupe = new InMemoryMessageDedupe();
    await dedupe.try_claim("42", "wamid-evict-1");
    const evicted = await evict_tenant_caches([
      { evict_tenant: async (tenant_id) => { await inbound.evict_tenant(tenant_id); } },
      { evict_tenant: async (tenant_id) => { await sessions.evict_tenant(tenant_id); } },
      { evict_tenant: async (tenant_id) => { await dedupe.evict_tenant(tenant_id); } },
    ], "42");
    expect(evicted).toBe(3);
    expect(await inbound.get("42", "wamid-evict-1")).toBeNull();
    expect(await sessions.load({ tenant_id: "42", conversation_id: "conversation-1" })).toBeNull();
    expect(await dedupe.has_seen("42", "wamid-evict-1")).toBe(false);
  });

  it("drops the cached sender so a deleted tenant resolves afresh", async () => {
    let factory_calls = 0;
    const credential_store = new TenantSenderCredentialStore(
      { get_secret: () => "secret-value" },
      new Map([["42", { phone_number_id_ref: "WHATSAPP_PHONE_ID", access_token_ref: "WHATSAPP_ACCESS_TOKEN" }]]),
    );
    const registry = new TenantSecretSenderRegistry({
      credential_store,
      sender_factory: () => {
        factory_calls += 1;
        return { send: async () => ({ delivered: true }) };
      },
    });
    const draft = { to: "+15551230000", message_type: "text" as const, text: "hello" };
    await registry.send("42", draft);
    await registry.send("42", draft);
    expect(factory_calls).toBe(1);
    registry.evict_cached_sender("42");
    await registry.send("42", draft);
    expect(factory_calls).toBe(2);
  });
});

describe("postgres erasure SQL contracts", () => {
  it("quarantines content with bounded tenant-scoped deletes and hold checks", async () => {
    const calls: string[] = [];
    const client: SqlClient = {
      query: async (sql) => {
        calls.push(sql);
        if (sql.includes("SELECT 1 FROM public.legal_holds")) return { rows: [] };
        if (sql.includes("DELETE FROM public.inbound_messages")) return { rows: [{ id: 1 }, { id: 2 }] };
        if (sql.includes("DELETE FROM public.reschedule_sessions")) return { rows: [{ id: 3 }] };
        if (sql.includes("DELETE FROM public.webhook_jobs")) return { rows: [{ id: 4 }] };
        if (sql.includes("DELETE FROM public.tenant_rate_limits")) return { rows: [{ tenant_id: "42" }] };
        throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
      },
    };
    const store = new PostgresTenantErasureStore(client);
    const deleted = await store.quarantine_tenant("42", 10);
    expect(deleted).toEqual({
      inbound_messages: 2,
      reschedule_sessions: 1,
      jobs: 1,
      rate_limit_buckets: 1,
      outbound_records: 0,
      dedupe_claims: 0,
      audit_records: 0,
    });
    const joined = calls.join("\n");
    expect(joined).toContain("legal_holds");
    const jobs_sql = calls.find((sql) => sql.includes("webhook_jobs")) ?? "";
    expect(jobs_sql).toContain("'pending'");
    expect(jobs_sql).toContain("'claimed'");
    expect(joined).not.toContain("processed_messages");
    expect(joined).not.toContain("DELETE FROM public.tenants");
  });

  it("cascades through the tenant row after deleting non-cascading jobs", async () => {
    const calls: string[] = [];
    const client: SqlClient = {
      query: async (sql) => {
        calls.push(sql);
        if (sql.includes("SELECT 1 FROM public.legal_holds")) return { rows: [] };
        if (sql.includes("DELETE FROM public.webhook_jobs")) return { rows: [{ id: 1 }] };
        if (sql.includes("DELETE FROM public.tenants")) return { rows: [{ id: 42 }] };
        throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
      },
    };
    const store = new PostgresTenantErasureStore(client);
    const result = await store.cascade_delete_tenant("42");
    expect(result).toEqual({ jobs_deleted: 1, tenant_removed: true });
    expect(calls.findIndex((sql) => sql.includes("webhook_jobs"))).toBeLessThan(
      calls.findIndex((sql) => sql.includes("DELETE FROM public.tenants")),
    );
  });

  it("blocks cascade under tenant and audit holds without deleting", async () => {
    const client: SqlClient = {
      query: async (sql) => {
        if (sql.includes("SELECT 1 FROM public.legal_holds")) return { rows: [{}] };
        throw new Error(`delete must not run under hold: ${sql.slice(0, 80)}`);
      },
    };
    const store = new PostgresTenantErasureStore(client);
    await expect(store.cascade_delete_tenant("42")).rejects.toBeInstanceOf(TenantErasureBlockedError);
  });

  it("reads export snapshots with counts and active holds", async () => {
    const handler = (sql: string): SqlQueryResult => {
      if (sql.includes("count(*)")) {
        return {
          rows: [{
            inbound_messages: "5",
            reschedule_sessions: "2",
            jobs_active: "3",
            jobs_terminal: "4",
            outbound_records: "6",
            dedupe_claims: "7",
            audit_records: "8",
            rate_limit_buckets: "2",
          }],
        };
      }
      return { rows: [{ scope: "tenant", reference: "matter-1", reason_code: "legal_request" }] };
    };
    const client: SqlClient = { query: async (sql) => handler(sql) };
    const store = new PostgresTenantErasureStore(client);
    const snapshot = await store.read_export_snapshot("42");
    expect(snapshot.counts).toMatchObject({ inbound_messages: 5, audit_records: 8 });
    expect(snapshot.active_legal_holds).toEqual(
      [{ scope: "tenant", reference: "matter-1", reason_code: "legal_request" }],
    );
    const exported = build_tenant_export("42", snapshot, { clock: () => FIXED_DATE });
    expect(exported.exported_at_iso).toBe("2026-09-29T00:00:00.000Z");
    expect(JSON.stringify(exported)).not.toContain("secret");
  });
});

function seeded_store_with_audit_hold(): InMemoryTenantErasureStore {
  const store = seeded_store();
  store.set_hold("42", "audit", "matter-2");
  return store;
}
