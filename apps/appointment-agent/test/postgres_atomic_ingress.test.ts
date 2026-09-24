import { describe, expect, it, vi } from "vitest";
import { AesGcmRecipientCipher } from "../src/security/recipient_cipher.js";
import type { InboundMessageRecord } from "../src/ingress/inbound_store.js";
import type {
  SqlClient,
  SqlQueryResult,
  SqlTransactionWork,
} from "../src/persistence/sql_client.js";
import {
  AtomicIngressStoreError,
  PostgresAtomicIngressStore,
  type AtomicIngressInput,
} from "../src/ingress/postgres_atomic_ingress.js";

const RECIPIENT_CIPHER = new AesGcmRecipientCipher(Buffer.alloc(32, 9));
const SENDER_PHONE = "+15551230000";
const MESSAGE_TEXT = "private inbound message";
const BASE_RECORD: InboundMessageRecord = {
  tenant_id: "42",
  wamid: "wamid.atomic-test",
  conversation_id: "conversation-atomic-test",
  message_type: "text",
  button_id: null,
  sender_ref: "sha256-sender-reference",
  reply_target_ciphertext: RECIPIENT_CIPHER.encrypt(SENDER_PHONE),
  message_text: MESSAGE_TEXT,
  received_at: "2026-09-24T08:00:00.000Z",
  expires_at: "2026-10-24T08:00:00.000Z",
  processed_at: null,
};

interface QueryCall {
  sql: string;
  values?: readonly unknown[];
}

interface Harness {
  client: SqlClient;
  calls: QueryCall[];
  transaction_commands: string[];
}

type QueryHandler = (sql: string, values?: readonly unknown[]) => SqlQueryResult | Promise<SqlQueryResult>;

function make_harness(handler: QueryHandler): Harness {
  const calls: QueryCall[] = [];
  const transaction_commands: string[] = [];
  const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
    calls.push({ sql, values });
    return handler(sql, values);
  });
  const client: SqlClient = {
    query,
    with_transaction: async <T>(work: SqlTransactionWork<T>): Promise<T> => {
      transaction_commands.push("BEGIN");
      try {
        const result = await work({ query });
        transaction_commands.push("COMMIT");
        return result;
      } catch (error) {
        transaction_commands.push("ROLLBACK");
        throw error;
      }
    },
  };
  return { client, calls, transaction_commands };
}

function input(overrides: Partial<AtomicIngressInput> = {}, record = BASE_RECORD): AtomicIngressInput {
  return {
    tenant_id: record.tenant_id,
    request_id: "request-atomic-test",
    received_at_iso: "2026-09-24T08:00:01.000Z",
    inbound_record: record,
    ...overrides,
  };
}

function successful_handler(sql: string, values?: readonly unknown[]): SqlQueryResult {
  if (sql.includes("INSERT INTO processed_messages")) {
    return { rows: [{ tenant_id: values?.[0], wamid: values?.[1] }], rowCount: 1 };
  }
  if (sql.includes("INSERT INTO inbound_messages")) return { rows: [{ id: 1 }], rowCount: 1 };
  if (sql.includes("INSERT INTO webhook_jobs")) return { rows: [{ id: 2 }], rowCount: 1 };
  throw new Error("unexpected SQL");
}

function duplicate_handler(sql: string, values?: readonly unknown[]): SqlQueryResult {
  if (sql.includes("INSERT INTO processed_messages")) {
    return { rows: [], rowCount: 0 };
  }
  if (sql.includes("FROM processed_messages AS pm")) {
    return { rows: [{ tenant_id: values?.[0], wamid: values?.[1] }], rowCount: 1 };
  }
  throw new Error("duplicate must not write payload tables");
}

describe("postgres atomic ingress store", () => {
  it("commits a claim, encrypted inbound row, and PII-free job", async () => {
    const harness = make_harness(successful_handler);
    const store = new PostgresAtomicIngressStore(harness.client);

    await expect(store.accept(input())).resolves.toEqual({
      status: "accepted",
      tenant_id: BASE_RECORD.tenant_id,
      wamid: BASE_RECORD.wamid,
    });

    expect(harness.transaction_commands).toEqual(["BEGIN", "COMMIT"]);
    const inserted_tables = harness.calls.map((call) => {
      if (!call.sql.includes("INSERT INTO")) return call.sql;
      return call.sql.split("INSERT INTO ")[1]?.split(" ")[0];
    });
    expect(inserted_tables).toEqual(["processed_messages", "inbound_messages", "webhook_jobs"]);
    expect(harness.calls[0]?.values).toEqual([BASE_RECORD.tenant_id, BASE_RECORD.wamid]);
    expect(harness.calls[1]?.values).toEqual([
      BASE_RECORD.tenant_id,
      BASE_RECORD.wamid,
      BASE_RECORD.conversation_id,
      BASE_RECORD.message_type,
      BASE_RECORD.button_id,
      BASE_RECORD.sender_ref,
      BASE_RECORD.reply_target_ciphertext,
      BASE_RECORD.message_text,
      BASE_RECORD.received_at,
      BASE_RECORD.expires_at,
    ]);
    expect(harness.calls[2]?.values).toEqual([
      BASE_RECORD.tenant_id,
      "request-atomic-test",
      BASE_RECORD.wamid,
      BASE_RECORD.conversation_id,
      "2026-09-24T08:00:01.000Z",
    ]);
  });

  it("snapshots mutable input before an asynchronous transaction starts", async () => {
    let release_transaction!: () => void;
    let mark_started!: () => void;
    const transaction_started = new Promise<void>((resolve) => {
      mark_started = resolve;
    });
    const transaction_gate = new Promise<void>((resolve) => {
      release_transaction = resolve;
    });
    const query = vi.fn(async (sql: string, values?: readonly unknown[]) => successful_handler(sql, values));
    const client: SqlClient = {
      query,
      with_transaction: async <T>(work: SqlTransactionWork<T>): Promise<T> => {
        mark_started();
        await transaction_gate;
        return work({ query });
      },
    };
    const store = new PostgresAtomicIngressStore(client);
    const mutable_input = input({}, { ...BASE_RECORD });
    const result = store.accept(mutable_input);
    await transaction_started;
    mutable_input.inbound_record.tenant_id = "99";
    mutable_input.inbound_record.wamid = "wamid.mutated";
    release_transaction();

    await expect(result).resolves.toMatchObject({
      status: "accepted",
      tenant_id: BASE_RECORD.tenant_id,
      wamid: BASE_RECORD.wamid,
    });
    expect(query.mock.calls[0]?.[1]).toEqual([BASE_RECORD.tenant_id, BASE_RECORD.wamid]);
    expect(query.mock.calls[2]?.[1]).toEqual([
      BASE_RECORD.tenant_id,
      "request-atomic-test",
      BASE_RECORD.wamid,
      BASE_RECORD.conversation_id,
      "2026-09-24T08:00:01.000Z",
    ]);
  });

  it("returns a duplicate without writing either payload table", async () => {
    const harness = make_harness(duplicate_handler);
    const store = new PostgresAtomicIngressStore(harness.client);

    await expect(store.accept(input())).resolves.toEqual({
      status: "duplicate",
      tenant_id: BASE_RECORD.tenant_id,
      wamid: BASE_RECORD.wamid,
    });
    expect(harness.transaction_commands).toEqual(["BEGIN", "COMMIT"]);
    expect(harness.calls).toHaveLength(2);
    expect(harness.calls[0]?.sql).toContain("ON CONFLICT (tenant_id, wamid) DO NOTHING");
    expect(harness.calls[1]?.sql).toContain("FROM processed_messages AS pm");
  });

  it("fails closed when an existing dedupe claim has no inbound row or job", async () => {
    const harness = make_harness((sql, values) => {
      if (sql.includes("INSERT INTO processed_messages")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM processed_messages AS pm")) return { rows: [], rowCount: 0 };
      throw new Error("orphan claim must not write payload tables");
    });
    const store = new PostgresAtomicIngressStore(harness.client);

    await expect(store.accept(input())).rejects.toMatchObject({
      name: "AtomicIngressStoreError",
      message: "atomic-ingress-orphan-claim",
    });
    expect(harness.transaction_commands).toEqual(["BEGIN", "ROLLBACK"]);
    expect(harness.calls).toHaveLength(2);
  });

  it("rolls back when the claim write fails", async () => {
    const harness = make_harness((sql) => {
      if (sql.includes("INSERT INTO processed_messages")) throw new Error("claim failure");
      return successful_handler(sql);
    });
    const store = new PostgresAtomicIngressStore(harness.client);

    await expect(store.accept(input())).rejects.toBeInstanceOf(AtomicIngressStoreError);
    expect(harness.transaction_commands).toEqual(["BEGIN", "ROLLBACK"]);
    expect(harness.calls).toHaveLength(1);
  });

  it("rolls back when the inbound write fails", async () => {
    const harness = make_harness((sql, values) => {
      if (sql.includes("INSERT INTO inbound_messages")) throw new Error("inbound failure");
      return successful_handler(sql, values);
    });
    const store = new PostgresAtomicIngressStore(harness.client);

    await expect(store.accept(input())).rejects.toBeInstanceOf(AtomicIngressStoreError);
    expect(harness.transaction_commands).toEqual(["BEGIN", "ROLLBACK"]);
    expect(harness.calls).toHaveLength(2);
  });

  it("rolls back when the queue write fails", async () => {
    const harness = make_harness((sql, values) => {
      if (sql.includes("INSERT INTO webhook_jobs")) throw new Error("queue failure");
      return successful_handler(sql, values);
    });
    const store = new PostgresAtomicIngressStore(harness.client);

    await expect(store.accept(input())).rejects.toBeInstanceOf(AtomicIngressStoreError);
    expect(harness.transaction_commands).toEqual(["BEGIN", "ROLLBACK"]);
    expect(harness.calls).toHaveLength(3);
  });

  it.each([
    ["claim", "INSERT INTO processed_messages"],
    ["inbound", "INSERT INTO inbound_messages"],
    ["job", "INSERT INTO webhook_jobs"],
  ])("rolls back on a malformed %s result", async (_name, failing_sql) => {
    const harness = make_harness((sql, values) => {
      if (sql.includes(failing_sql)) return {};
      return successful_handler(sql, values);
    });
    const store = new PostgresAtomicIngressStore(harness.client);

    await expect(store.accept(input())).rejects.toBeInstanceOf(AtomicIngressStoreError);
    expect(harness.transaction_commands).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it("scopes claims by tenant and allows the same WAMID in another tenant", async () => {
    const claimed = new Set<string>();
    const harness = make_harness((sql, values) => {
      if (sql.includes("INSERT INTO processed_messages")) {
        const key = `${String(values?.[0])}\u0000${String(values?.[1])}`;
        if (claimed.has(key)) return { rows: [], rowCount: 0 };
        claimed.add(key);
        return { rows: [{ tenant_id: values?.[0], wamid: values?.[1] }], rowCount: 1 };
      }
      if (sql.includes("FROM processed_messages AS pm")) {
        return { rows: [{ tenant_id: values?.[0], wamid: values?.[1] }], rowCount: 1 };
      }
      return successful_handler(sql, values);
    });
    const store = new PostgresAtomicIngressStore(harness.client);
    const other_record = { ...BASE_RECORD, tenant_id: "43" };

    await expect(store.accept(input())).resolves.toMatchObject({ status: "accepted", tenant_id: "42" });
    await expect(store.accept(input())).resolves.toMatchObject({ status: "duplicate", tenant_id: "42" });
    await expect(store.accept(input({}, other_record))).resolves.toMatchObject({ status: "accepted", tenant_id: "43" });
    const claim_values = harness.calls
      .filter((call) => call.sql.includes("processed_messages"))
      .at(0)?.values;
    expect(claim_values).toEqual(["42", BASE_RECORD.wamid]);
  });

  it("keeps plaintext recipient and message data out of queue parameters", async () => {
    const harness = make_harness(successful_handler);
    const store = new PostgresAtomicIngressStore(harness.client);

    await store.accept(input());
    const queue_call = harness.calls.find((call) => call.sql.includes("INSERT INTO webhook_jobs"));
    expect(queue_call).toBeDefined();
    expect(JSON.stringify(queue_call?.values)).not.toContain(SENDER_PHONE);
    expect(JSON.stringify(queue_call?.values)).not.toContain(MESSAGE_TEXT);
    expect(JSON.stringify(queue_call?.values)).not.toContain(BASE_RECORD.sender_ref);
    expect(JSON.stringify(queue_call?.values)).not.toContain(BASE_RECORD.reply_target_ciphertext);
  });

  it("rejects invalid scope or plaintext reply target before opening a transaction", async () => {
    const harness = make_harness(successful_handler);
    const store = new PostgresAtomicIngressStore(harness.client);

    await expect(store.accept(input({ tenant_id: "99" }))).rejects.toMatchObject({
      name: "AtomicIngressStoreError",
      message: "atomic-ingress-tenant-scope-invalid",
    });
    await expect(
      store.accept(input({}, { ...BASE_RECORD, reply_target_ciphertext: SENDER_PHONE })),
    ).rejects.toMatchObject({
      name: "AtomicIngressStoreError",
      message: "atomic-ingress-reply-target-invalid",
    });
    expect(harness.transaction_commands).toEqual([]);
    expect(harness.calls).toEqual([]);
  });

  it("fails closed when the client has no transaction runner", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const store = new PostgresAtomicIngressStore({ query } satisfies SqlClient);

    await expect(store.accept(input())).rejects.toMatchObject({
      name: "AtomicIngressStoreError",
      message: "atomic-ingress-transaction-unavailable",
    });
    expect(query).not.toHaveBeenCalled();
  });
});
