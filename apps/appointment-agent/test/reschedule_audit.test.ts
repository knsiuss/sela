import { describe, expect, it, vi } from "vitest";
import {
  InMemoryRescheduleAudit,
  PostgresRescheduleAudit,
  RescheduleAuditError,
} from "../src/reschedule/audit.js";
import type { SqlClient } from "../src/persistence/sql_client.js";

const APPOINTMENT_ID = "10000000-0000-4000-8000-000000000001";

describe("reschedule audit", () => {
  it("persists only bounded identifiers and a stable rejection reason", async () => {
    const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows: [], rowCount: 1 }));
    const audit = new PostgresRescheduleAudit({ query } satisfies SqlClient);

    await audit.record_rejection({
      tenant_id: "42",
      conversation_id: "conversation-opaque",
      appointment_id: APPOINTMENT_ID,
      reason: "appointment_not_reschedulable",
    });

    expect(query).toHaveBeenCalledWith(expect.stringContaining("'reschedule_rejected'"), [
      "42",
      APPOINTMENT_ID,
      JSON.stringify({
        reason: "appointment_not_reschedulable",
        conversation_id: "conversation-opaque",
        appointment_id: APPOINTMENT_ID,
      }),
    ]);
    expect(JSON.stringify(query.mock.calls)).not.toMatch(/message|phone|recipient/i);
  });

  it("uses a bounded conversation entity when no appointment was attached", async () => {
    const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows: [], rowCount: 1 }));
    const audit = new PostgresRescheduleAudit({ query } satisfies SqlClient);

    await audit.record_rejection({
      tenant_id: "42",
      conversation_id: "conversation-opaque",
      reason: "appointment_context_missing",
    });

    expect(query.mock.calls[0]?.[1]?.[1]).toBe("conversation:conversation-opaque");
  });

  it("rejects malformed identifiers and sanitizes persistence failures", async () => {
    const audit = new PostgresRescheduleAudit({
      query: vi.fn(async () => {
        throw new Error("password=secret internal SQL");
      }),
    } satisfies SqlClient);

    await expect(audit.record_rejection({
      tenant_id: "42",
      conversation_id: "",
      reason: "appointment_context_missing",
    })).rejects.toBeInstanceOf(RescheduleAuditError);
    const error = await audit.record_rejection({
      tenant_id: "42",
      conversation_id: "conversation-opaque",
      reason: "appointment_context_missing",
    }).catch((value: unknown) => value);
    expect(String(error)).not.toMatch(/secret|internal SQL/);
  });

  it("collects deterministic local rejections", async () => {
    const audit = new InMemoryRescheduleAudit();
    const input = {
      tenant_id: "42",
      conversation_id: "conversation-opaque",
      reason: "appointment_context_missing" as const,
    };

    await audit.record_rejection(input);
    expect(audit.rejections).toEqual([input]);
    expect(audit.rejections[0]).not.toBe(input);
  });
});
