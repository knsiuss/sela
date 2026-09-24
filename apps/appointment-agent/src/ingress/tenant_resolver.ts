/** Channel-to-tenant resolution for the WhatsApp ingress boundary. */

import type { SqlClient, SqlQueryResult } from "../persistence/sql_client.js";

/** Tenant identifier carried by ingress jobs and database rows. */
export type TenantId = string;

/** Read-only port for resolving a channel account to its tenant. */
export interface TenantResolver {
  /**
   * Resolve a channel account.
   *
   * @param channel_account_id - Provider account id, such as Meta phone_number_id.
   * @param channel - Channel name; defaults to WhatsApp.
   * @param signal - Optional request cancellation signal for database lookups.
   * @returns Tenant id, or null when the mapping is unknown.
   */
  resolve(
    channel_account_id: string,
    channel?: string,
    signal?: AbortSignal,
  ): Promise<TenantId | null>;
}

/** Safe failure when the resolver database is unavailable. */
export class TenantResolverError extends Error {
  /** Create a resolver error without including the channel account. */
  constructor(reason = "tenant-resolution-failed", cause?: unknown) {
    super(reason, cause === undefined ? undefined : { cause });
    this.name = "TenantResolverError";
  }
}

const SELECT_TENANT_SQL = `
  SELECT tenant_id
  FROM tenant_channels
  WHERE channel = $1 AND channel_account_id = $2
  LIMIT 1
`;

/** Resolve channel mappings through a parameterized SQL query. */
export class SqlTenantResolver implements TenantResolver {
  private readonly sql_client: SqlClient;

  /**
   * Create a SQL-backed resolver.
   *
   * @param sql_client - Server-side SQL boundary.
   */
  constructor(sql_client: SqlClient) {
    this.sql_client = sql_client;
  }

  /**
   * Look up one channel mapping.
   *
   * @param channel_account_id - Provider account id from the webhook.
   * @param channel - Channel name; defaults to WhatsApp.
   * @returns The mapped tenant id or null.
   */
  async resolve(
    channel_account_id: string,
    channel = "whatsapp",
    signal?: AbortSignal,
  ): Promise<TenantId | null> {
    const account_id = require_account_id(channel_account_id);
    const channel_name = require_channel(channel);
    try {
      const result = signal === undefined
        ? await this.sql_client.query(SELECT_TENANT_SQL, [channel_name, account_id])
        : await this.sql_client.query(SELECT_TENANT_SQL, [channel_name, account_id], signal);
      return read_tenant_id(result);
    } catch (error) {
      if (error instanceof TenantResolverError) throw error;
      throw new TenantResolverError("tenant-resolution-query-failed", error);
    }
  }
}

/** In-memory resolver used by tests and explicit local composition. */
export class InMemoryTenantResolver implements TenantResolver {
  private readonly mappings = new Map<string, TenantId>();

  /**
   * Create a resolver from account-id mappings.
   *
   * @param mappings - Optional WhatsApp account-id to tenant-id mappings.
   */
  constructor(
    mappings:
      | Readonly<Record<string, TenantId>>
      | ReadonlyMap<string, TenantId>
      | readonly (readonly [string, TenantId])[] = {},
  ) {
    const entries =
      mappings instanceof Map
        ? [...mappings.entries()]
        : Array.isArray(mappings)
          ? mappings
          : Object.entries(mappings);
    for (const [account_id, tenant_id] of entries) this.register(account_id, tenant_id);
  }

  /**
   * Add or replace one channel mapping.
   *
   * @param channel_account_id - Provider account id.
   * @param tenant_id - Owning tenant id.
   * @param channel - Channel name; defaults to WhatsApp.
   * @returns Nothing.
   */
  register(channel_account_id: string, tenant_id: TenantId, channel = "whatsapp"): void {
    const account_id = require_account_id(channel_account_id);
    const channel_name = require_channel(channel);
    if (typeof tenant_id !== "string" || tenant_id.trim() === "") {
      throw new TenantResolverError("tenant-id-invalid");
    }
    this.mappings.set(mapping_key(channel_name, account_id), tenant_id);
  }

  /**
   * Resolve one configured mapping.
   *
   * @param channel_account_id - Provider account id.
   * @param channel - Channel name; defaults to WhatsApp.
   * @returns The mapped tenant id or null.
   */
  async resolve(
    channel_account_id: string,
    channel = "whatsapp",
    _signal?: AbortSignal,
  ): Promise<TenantId | null> {
    const account_id = require_account_id(channel_account_id);
    const channel_name = require_channel(channel);
    return this.mappings.get(mapping_key(channel_name, account_id)) ?? null;
  }
}

function read_tenant_id(result: SqlQueryResult): TenantId | null {
  if (!Array.isArray(result.rows) || result.rows.length === 0) return null;
  const row = result.rows[0];
  if (typeof row !== "object" || row === null) throw new TenantResolverError("tenant-resolution-row-invalid");
  const value = (row as Record<string, unknown>)["tenant_id"];
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
    throw new TenantResolverError("tenant-resolution-row-invalid");
  }
  const tenant_id = String(value);
  if (!/^[1-9]\d*$/.test(tenant_id)) throw new TenantResolverError("tenant-resolution-row-invalid");
  return tenant_id;
}

function mapping_key(channel: string, account_id: string): string {
  return `${channel}\u0000${account_id}`;
}

function require_account_id(value: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 256) {
    throw new TenantResolverError("channel-account-invalid");
  }
  return value;
}

function require_channel(value: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 64) {
    throw new TenantResolverError("channel-invalid");
  }
  return value;
}
