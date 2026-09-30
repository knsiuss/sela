/** User lifecycle state machine: invite, activate, suspend, revoke. */

import type { AuthenticatedPrincipal } from "./authorization.js";

/** Lifecycle states; revoked is terminal. */
export type UserLifecycleStatus = "invited" | "active" | "suspended" | "revoked";

/** One user membership record scoped to an org and tenant. */
export interface UserRecord {
  user_id: string;
  org_id: string;
  tenant_id: string;
  status: UserLifecycleStatus;
  invited_at_iso: string;
  activated_at_iso: string | null;
  suspended_at_iso: string | null;
  revoked_at_iso: string | null;
  updated_at_iso: string;
}

/** Input for inviting a user. */
export interface InviteUserInput {
  user_id: string;
  org_id: string;
  tenant_id: string;
  clock?: () => Date;
}

/** Failure with a stable machine-readable code. */
export class UserLifecycleError extends Error {
  readonly code: string;

  /** Create a sanitized lifecycle failure. */
  constructor(code: string) {
    super(code);
    this.name = "UserLifecycleError";
    this.code = code;
  }
}

/**
 * Invite a user into an org/tenant scope.
 *
 * @param input - User, org, and tenant identifiers.
 * @returns A new record in invited status.
 */
export function invite_user(input: InviteUserInput): UserRecord {
  if (typeof input !== "object" || input === null) throw new UserLifecycleError("user-invite-invalid");
  const user_id = require_safe_id(input.user_id, "user-invite-invalid");
  const org_id = require_safe_id(input.org_id, "user-invite-invalid");
  const tenant_id = require_tenant_id(input.tenant_id);
  const now = (input.clock ?? (() => new Date()))().toISOString();
  return {
    user_id, org_id, tenant_id, status: "invited",
    invited_at_iso: now, activated_at_iso: null,
    suspended_at_iso: null, revoked_at_iso: null, updated_at_iso: now,
  };
}

/**
 * Activate an invited or suspended user.
 *
 * @param record - Current user record.
 * @param clock - Optional clock for timestamps.
 * @returns Updated record in active status.
 */
export function activate_user(record: UserRecord, clock: () => Date = () => new Date()): UserRecord {
  const current = require_record(record);
  if (current.status !== "invited" && current.status !== "suspended") {
    throw new UserLifecycleError(`user-activate-illegal-from-${current.status}`);
  }
  const now = clock().toISOString();
  return {
    ...current, status: "active", activated_at_iso: current.activated_at_iso ?? now,
    suspended_at_iso: null, updated_at_iso: now,
  };
}

/**
 * Suspend an active user.
 *
 * @param record - Current user record.
 * @param clock - Optional clock for timestamps.
 * @returns Updated record in suspended status.
 */
export function suspend_user(record: UserRecord, clock: () => Date = () => new Date()): UserRecord {
  const current = require_record(record);
  if (current.status !== "active") throw new UserLifecycleError(`user-suspend-illegal-from-${current.status}`);
  const now = clock().toISOString();
  return { ...current, status: "suspended", suspended_at_iso: now, updated_at_iso: now };
}

/**
 * Revoke a user; terminal and irreversible.
 *
 * @param record - Current user record.
 * @param clock - Optional clock for timestamps.
 * @returns Updated record in revoked status.
 */
export function revoke_user(record: UserRecord, clock: () => Date = () => new Date()): UserRecord {
  const current = require_record(record);
  if (current.status === "revoked") throw new UserLifecycleError("user-revoke-illegal-from-revoked");
  const now = clock().toISOString();
  return { ...current, status: "revoked", revoked_at_iso: now, updated_at_iso: now };
}

/**
 * Return true only for active users.
 *
 * @param record - User record to inspect.
 * @returns True when status is active.
 */
export function is_active_user(record: UserRecord): boolean {
  return require_record(record).status === "active";
}

/**
 * Require the caller principal to hold the target tenant membership.
 *
 * @param principal - Verified principal with tenant roles.
 * @param tenant_id - Tenant being acted on.
 * @returns The tenant id when membership exists.
 */
export function require_tenant_membership(principal: AuthenticatedPrincipal, tenant_id: string): string {
  require_tenant_id(tenant_id);
  const roles = (principal as AuthenticatedPrincipal).tenant_roles?.[tenant_id];
  if (!Array.isArray(roles) || roles.length === 0) throw new UserLifecycleError("user-tenant-forbidden");
  return tenant_id;
}

/** In-memory lifecycle adapter for tests and explicit local mode. */
export class InMemoryUserLifecycleStore {
  private readonly rows = new Map<string, UserRecord>();

  /**
   * Invite and persist one user.
   *
   * @param input - Invite input.
   * @returns The persisted record.
   */
  async invite(input: InviteUserInput): Promise<UserRecord> {
    const record = invite_user(input);
    if (this.rows.has(record.user_id)) throw new UserLifecycleError("user-already-exists");
    this.rows.set(record.user_id, record);
    return { ...record };
  }

  /**
   * Read one user record.
   *
   * @param user_id - User identifier.
   * @returns A copy or null when absent.
   */
  async get(user_id: string): Promise<UserRecord | null> {
    const found = this.rows.get(user_id);
    return found === undefined ? null : { ...found };
  }

  /**
   * Persist an already-transitioned record.
   *
   * @param record - Updated record.
   * @returns A copy of the stored record.
   */
  async save(record: UserRecord): Promise<UserRecord> {
    const current = require_record(record);
    this.rows.set(current.user_id, { ...current });
    return { ...current };
  }
}

function require_record(value: UserRecord): UserRecord {
  if (typeof value !== "object" || value === null) throw new UserLifecycleError("user-record-invalid");
  require_safe_id(value.user_id, "user-record-invalid");
  require_safe_id(value.org_id, "user-record-invalid");
  require_tenant_id(value.tenant_id);
  if (!is_status(value.status)) throw new UserLifecycleError("user-record-invalid");
  return value;
}

function is_status(value: unknown): value is UserLifecycleStatus {
  return value === "invited" || value === "active" || value === "suspended" || value === "revoked";
}

function require_tenant_id(value: string): string {
  if (typeof value !== "string" || !/^[1-9]\d{0,18}$/.test(value)) throw new UserLifecycleError("user-tenant-invalid");
  return value;
}

function require_safe_id(value: string, code: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256
    || value.trim() !== value || /[\u0000-]/u.test(value)) throw new UserLifecycleError(code);
  return value;
}
