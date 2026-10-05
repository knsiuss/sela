import type { SqlClient, SqlQueryResult } from "../../src/persistence/sql_client.js";

/** Timestamp the double uses when a test needs a row to look revoked. */
const REVOKED_AT = "2026-09-25T00:00:00.000Z";

/**
 * An in-memory stand-in for the tables the durable staff-auth adapters touch.
 *
 * It dispatches on the table named in each statement, which is enough to model the
 * semantics the adapters actually depend on: primary-key lookup, the conditional
 * single-use claim, and the compare-and-delete that protects a re-consented grant.
 * Two clients over the same instance model a process restart and a second replica.
 *
 * What it cannot model, and no assertion here claims to: whether the statements are
 * valid SQL, whether the migration's constraints accept the rows, and whether the
 * database enforces the conditional claim. Those need a live PostgreSQL.
 */
export class FakeAuthTables {
  readonly states = new Map<string, Record<string, unknown>>();
  readonly sessions = new Map<string, Record<string, unknown>>();
  readonly grants = new Map<string, Record<string, unknown>>();
  /** Every statement and its bound values, so a test can assert what was sent. */
  readonly calls: Array<{ sql: string; values: readonly unknown[] }> = [];

  /** Build a client over these tables; two clients model two instances. */
  client(): SqlClient {
    const tables = this;
    return {
      async query(sql: string, values: readonly unknown[] = []): Promise<SqlQueryResult> {
        tables.calls.push({ sql, values });
        if (sql.includes("oauth_authorization_states")) return tables.run_state(sql, values);
        if (sql.includes("staff_sessions")) return tables.run_session(sql, values);
        if (sql.includes("google_token_grants")) return tables.run_grant(sql, values);
        throw new Error(`unexpected-statement`);
      },
    };
  }

  /** Statements against the authorization-state table. */
  private run_state(sql: string, values: readonly unknown[]): SqlQueryResult {
    if (sql.includes("INSERT INTO")) {
      const row = {
        state_hash: values[0],
        purpose: values[1],
        idp: values[2],
        tenant_id: values[3],
        return_path: values[4],
        code_verifier: values[5],
        nonce: values[6],
        issued_at: values[7],
        expires_at: values[8],
        consumed_at: null,
      };
      this.states.set(String(values[0]), row);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SET consumed_at")) {
      const row = this.states.get(String(values[0]));
      if (row === undefined || row.consumed_at !== null || Number(row.expires_at) <= Number(values[1])) {
        return { rows: [], rowCount: 0 };
      }
      row.consumed_at = values[1];
      return { rows: [row], rowCount: 1 };
    }
    if (sql.includes("SELECT consumed_at")) {
      const row = this.states.get(String(values[0]));
      return { rows: row === undefined ? [] : [row], rowCount: row === undefined ? 0 : 1 };
    }
    if (sql.includes("DELETE FROM")) {
      let removed = 0;
      for (const [key, row] of this.states) {
        if (Number(row.expires_at) < Number(values[0])) {
          this.states.delete(key);
          removed += 1;
        }
      }
      return { rows: [], rowCount: removed };
    }
    throw new Error("unexpected-state-statement");
  }

  /** Statements against the staff-session table. */
  private run_session(sql: string, values: readonly unknown[]): SqlQueryResult {
    if (sql.includes("INSERT INTO")) {
      this.sessions.set(String(values[0]), {
        session_id: values[0],
        subject_id: values[1],
        issuer: values[2],
        idp: values[3],
        secret_hash: values[4],
        has_mfa: values[5],
        tenant_roles: JSON.parse(String(values[6])) as unknown,
        tenant_id: values[7],
        device_hash: values[8],
        session_created_at: values[9],
        session_last_seen_at: values[10],
        session_revoked_at: null,
        expires_at: values[11],
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SET session_revoked_at")) {
      const row = this.sessions.get(String(values[0]));
      if (row === undefined || row.session_revoked_at !== null) return { rows: [], rowCount: 0 };
      row.session_revoked_at = REVOKED_AT;
      return { rows: [{ session_id: values[0] }], rowCount: 1 };
    }
    if (sql.includes("SET session_last_seen_at = $2, updated_at") && sql.includes("revoked_at IS NULL")) {
      const row = this.sessions.get(String(values[0]));
      if (row === undefined || row.session_revoked_at !== null) return { rows: [], rowCount: 0 };
      row.session_last_seen_at = values[1];
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("DELETE FROM")) {
      const removed = this.sessions.delete(String(values[0]));
      return { rows: [], rowCount: removed ? 1 : 0 };
    }
    if (sql.includes("WHERE subject_id = $1")) {
      const rows = [...this.sessions.values()].filter((row) => row.subject_id === values[0]);
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("WHERE session_id = $1")) {
      const row = this.sessions.get(String(values[0]));
      return { rows: row === undefined ? [] : [row], rowCount: row === undefined ? 0 : 1 };
    }
    throw new Error("unexpected-session-statement");
  }

  /** Statements against the grant table, keyed by tenant like its partial index. */
  private run_grant(sql: string, values: readonly unknown[]): SqlQueryResult {
    if (sql.includes("INSERT INTO")) {
      // The partial unique index is on `tenant_id`, so re-consent replaces the row
      // the tenant already had rather than accumulating a second one.
      this.grants.set(String(values[1]), {
        grant_id: values[0],
        tenant_id: String(values[1]),
        google_subject_id: values[2],
        authorized_by_subject_id: values[3],
        scopes: [...(values[4] as string[])],
        encrypted_refresh_token: values[5],
        created_at: values[6],
        last_used_at: null,
        revoked_at: null,
      });
      return { rows: [this.grants.get(String(values[1]))], rowCount: 1 };
    }
    if (sql.includes("DELETE FROM")) {
      const row = this.grants.get(String(values[0]));
      if (row === undefined || row.grant_id !== String(values[1])) return { rows: [], rowCount: 0 };
      this.grants.delete(String(values[0]));
      return { rows: [{ grant_id: values[1] }], rowCount: 1 };
    }
    if (sql.includes("SET last_used_at")) {
      const row = this.grants.get(String(values[0]));
      if (row !== undefined && row.revoked_at === null) row.last_used_at = values[1];
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SET revoked_at")) {
      const row = this.grants.get(String(values[0]));
      if (row !== undefined && row.revoked_at === null) row.revoked_at = values[1];
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("WHERE tenant_id = $1::bigint")) {
      const row = this.grants.get(String(values[0]));
      return { rows: row === undefined ? [] : [row], rowCount: row === undefined ? 0 : 1 };
    }
    return { rows: [...this.grants.values()], rowCount: this.grants.size };
  }
}
