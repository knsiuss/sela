/** Access-review reporting over existing identity evidence. */

import type { ApiKeyRecord } from "./api_keys.js";
import type { SessionRecord } from "./session_registry.js";
import type { UserRecord } from "./user_lifecycle.js";

/** Counts-only review report; findings carry codes, never user ids. */
export interface AccessReviewReport {
  generated_at_iso: string;
  tenant_id: string;
  active_users: number;
  suspended_users: number;
  revoked_users: number;
  active_sessions: number;
  revoked_sessions: number;
  active_api_keys: number;
  expired_or_revoked_keys: number;
  findings: readonly string[];
}

/** Inputs assembled from lifecycle, session, and key stores plus audit counts. */
export interface AccessReviewInput {
  users: readonly UserRecord[];
  sessions: readonly SessionRecord[];
  api_keys: readonly ApiKeyRecord[];
  clock?: () => Date;
  session_stale_days?: number;
}

/** Failure with a stable machine-readable code. */
export class AccessReviewError extends Error {
  readonly code: string;

  /** Create a sanitized review failure. */
  constructor(code: string) {
    super(code);
    this.name = "AccessReviewError";
    this.code = code;
  }
}

/**
 * Build a counts-only access review for one tenant.
 *
 * Findings are bounded codes (stale-session-present, suspended-with-session,
 * expired-key-present, revoked-user-with-session) so the report is safe to
 * store as governance evidence.
 *
 * @param tenant_id - Tenant under review.
 * @param input - Identity evidence snapshots.
 * @returns Counts-only report.
 */
export function build_access_review(tenant_id: string, input: AccessReviewInput): AccessReviewReport {
  if (typeof tenant_id !== "string" || !/^[1-9]\d{0,18}$/.test(tenant_id)) {
    throw new AccessReviewError("access-review-tenant-invalid");
  }
  if (typeof input !== "object" || input === null) throw new AccessReviewError("access-review-invalid");
  const stale_days = input.session_stale_days ?? 30;
  if (!Number.isSafeInteger(stale_days) || stale_days < 1 || stale_days > 3650) {
    throw new AccessReviewError("access-review-stale-invalid");
  }
  const now_ms = (input.clock ?? (() => new Date()))().getTime();
  const users = input.users.filter((user) => user.tenant_id === tenant_id);
  const sessions = input.sessions.filter((session) => session.tenant_id === tenant_id);
  const keys = input.api_keys.filter((key) => key.tenant_id === tenant_id);
  const active_sessions = sessions.filter((session) => session.revoked_at_iso === null);
  const stale_cutoff = now_ms - stale_days * 86_400_000;
  const findings: string[] = [];
  if (active_sessions.some((session) => Date.parse(session.last_seen_at_iso) < stale_cutoff)) {
    findings.push("stale-session-present");
  }
  if (users.some((user) => user.status === "suspended")
    && active_sessions.length > 0) findings.push("suspended-with-session");
  if (users.some((user) => user.status === "revoked")
    && sessions.some((session) => session.revoked_at_iso === null
      && users.some((user) => user.status === "revoked" && user.user_id === session.subject_id))) {
    findings.push("revoked-user-with-session");
  }
  if (keys.some((key) => key.revoked_at_iso !== null || Date.parse(key.expires_at_iso) <= now_ms)) {
    findings.push("expired-key-present");
  }
  return Object.freeze({
    generated_at_iso: new Date(now_ms).toISOString(),
    tenant_id,
    active_users: users.filter((user) => user.status === "active").length,
    suspended_users: users.filter((user) => user.status === "suspended").length,
    revoked_users: users.filter((user) => user.status === "revoked").length,
    active_sessions: active_sessions.length,
    revoked_sessions: sessions.length - active_sessions.length,
    active_api_keys: keys.filter((key) => key.revoked_at_iso === null && Date.parse(key.expires_at_iso) > now_ms).length,
    expired_or_revoked_keys: keys.length
      - keys.filter((key) => key.revoked_at_iso === null && Date.parse(key.expires_at_iso) > now_ms).length,
    findings: Object.freeze([...findings]),
  });
}
