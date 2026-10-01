/** Audited, tenant-scoped operator action boundary for enterprise APIs. */

import type { SqlClient } from "../persistence/sql_client.js";
import {
  authorize_privileged,
  AuthorizationError,
  parse_authenticated_principal,
  type AuthenticatedPrincipal,
  type EnterprisePermission,
} from "./authorization.js";

/** Actions exposed only through an explicitly authorized operator workflow. */
export type OperatorAction =
  | "replay_outbound"
  | "reconcile_orphan"
  | "release_hold"
  | "resolve_conflict"
  | "export_audit";

/** One requested operator mutation or controlled read. */
export interface OperatorActionRequest {
  principal: AuthenticatedPrincipal;
  tenant_id: string;
  action: OperatorAction;
  target_id: string;
  request_id: string;
  reason: string;
}

/** Result returned after authorization, execution, and audit persistence. */
export interface OperatorActionResult {
  action: OperatorAction;
  tenant_id: string;
  target_id: string;
  outcome: "succeeded" | "denied" | "failed";
  reason_code?: string;
}

/** Narrow action ledger port. */
export interface OperatorActionAuditStore {
  record(input: {
    tenant_id: string;
    actor_subject: string;
    action: OperatorAction;
    target_id: string;
    outcome: OperatorActionResult["outcome"];
    request_id: string;
    reason_code?: string;
  }): Promise<void>;
}

/** Callback that performs the already-authorized side effect. */
export type OperatorActionHandler = (request: OperatorActionRequest) => Promise<void>;

/** Coordinates authorization, side effect, and append-only evidence. */
export class OperatorActionService {
  private readonly audit: OperatorActionAuditStore;
  private readonly handler: OperatorActionHandler;

  /** Create a service with explicit authorization and side-effect boundaries. */
  constructor(audit: OperatorActionAuditStore, handler: OperatorActionHandler) {
    this.audit = audit;
    this.handler = handler;
  }

  /**
   * Validate a request and return the normalized principal without side effects.
   *
   * The API uses this preflight before consuming a tenant-scoped rate-limit
   * bucket, so a valid token cannot exhaust another tenant's bucket.
   */
  authorize(request: OperatorActionRequest): OperatorActionRequest {
    const normalized = normalize_request(request);
    const principal = parse_authenticated_principal(normalized.principal);
    if (normalized.action !== "export_audit" && !principal.has_mfa) {
      throw new AuthorizationError("mfa_required");
    }
    authorize_privileged(principal, normalized.tenant_id, permission_for(normalized.action));
    return { ...normalized, principal };
  }

  /** Record a denied preflight without invoking the side-effect handler. */
  async record_denial(request: OperatorActionRequest): Promise<void> {
    const normalized = normalize_request(request);
    let actor_subject = "unverified";
    try {
      actor_subject = parse_authenticated_principal(normalized.principal).subject_id;
    } catch {
      // Keep the audit record safe when a verifier returned malformed claims.
    }
    await this.audit.record({
      tenant_id: normalized.tenant_id,
      actor_subject,
      action: normalized.action,
      target_id: normalized.target_id,
      outcome: "denied",
      request_id: normalized.request_id,
      reason_code: "authorization_denied",
    });
  }

  /** Execute one action; authorization and audit failures are not swallowed. */
  async execute(request: OperatorActionRequest): Promise<OperatorActionResult> {
    const normalized = normalize_request(request);
    let actor_subject = "unverified";
    try {
      const authorized = this.authorize(normalized);
      actor_subject = authorized.principal.subject_id;
      await this.handler(authorized);
      const result: OperatorActionResult = {
        action: authorized.action,
        tenant_id: authorized.tenant_id,
        target_id: authorized.target_id,
        outcome: "succeeded",
      };
      await this.audit.record({
        tenant_id: authorized.tenant_id,
        actor_subject,
        action: authorized.action,
        target_id: authorized.target_id,
        outcome: result.outcome,
        request_id: authorized.request_id,
      });
      return result;
    } catch (error) {
      const denied = error instanceof AuthorizationError;
      const result: OperatorActionResult = {
        action: normalized.action,
        tenant_id: normalized.tenant_id,
        target_id: normalized.target_id,
        outcome: denied ? "denied" : "failed",
        reason_code: denied ? "authorization_denied" : safe_reason(error),
      };
      await this.audit.record({
        tenant_id: normalized.tenant_id,
        actor_subject,
        action: normalized.action,
        target_id: normalized.target_id,
        outcome: result.outcome,
        request_id: normalized.request_id,
        reason_code: result.reason_code,
      });
      throw error;
    }
  }
}

/** In-memory audit adapter for API tests and explicit local mode. */
export class InMemoryOperatorActionAudit implements OperatorActionAuditStore {
  readonly records: Array<Parameters<OperatorActionAuditStore["record"]>[0]> = [];

  /** Append one bounded action record. */
  async record(input: Parameters<OperatorActionAuditStore["record"]>[0]): Promise<void> {
    this.records.push({ ...input });
  }
}

const INSERT_OPERATOR_AUDIT_SQL = `
  INSERT INTO public.operator_action_audit (
    tenant_id, actor_subject, action, target_type, target_id, outcome, reason_code, request_id
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
`;

/** Server-side Postgres audit adapter. */
export class PostgresOperatorActionAudit implements OperatorActionAuditStore {
  private readonly sql_client: SqlClient;

  /** Create the append-only adapter. */
  constructor(sql_client: SqlClient) {
    this.sql_client = sql_client;
  }

  /** Record one operator attempt without storing free-form reason text. */
  async record(input: Parameters<OperatorActionAuditStore["record"]>[0]): Promise<void> {
    try {
      await this.sql_client.query(INSERT_OPERATOR_AUDIT_SQL, [
        input.tenant_id,
        input.actor_subject,
        input.action,
        "operator_target",
        input.target_id,
        input.outcome,
        input.reason_code ?? null,
        input.request_id,
      ]);
    } catch (error) {
      throw new OperatorActionAuditError("operator-action-audit-failed", error);
    }
  }
}

/** Sanitized persistence failure. */
export class OperatorActionAuditError extends Error {
  /** Create a safe audit failure. */
  constructor(reason: string, cause?: unknown) {
    super(reason, cause === undefined ? undefined : { cause });
    this.name = "OperatorActionAuditError";
  }
}

function permission_for(action: OperatorAction): EnterprisePermission {
  if (action === "replay_outbound") return "outbound:replay";
  if (action === "export_audit") return "audit:read";
  if (action === "resolve_conflict") return "appointments:reschedule";
  return "handoff:read";
}

function normalize_request(value: OperatorActionRequest): OperatorActionRequest {
  if (
    typeof value !== "object" ||
    value === null ||
    !/^[1-9]\d{0,18}$/.test(value.tenant_id) ||
    !is_action(value.action) ||
    !safe_id(value.target_id) ||
    !safe_id(value.request_id) ||
    !safe_reason_text(value.reason)
  ) {
    throw new TypeError("operator-action-request-invalid");
  }
  return {
    principal: value.principal,
    tenant_id: value.tenant_id,
    action: value.action,
    target_id: value.target_id,
    request_id: value.request_id,
    reason: value.reason,
  };
}

function is_action(value: unknown): value is OperatorAction {
  return value === "replay_outbound" || value === "reconcile_orphan" || value === "release_hold" || value === "resolve_conflict" || value === "export_audit";
}

function safe_id(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function safe_reason_text(value: string): boolean {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 512;
}

function safe_reason(error: unknown): string {
  if (error instanceof Error && error.name !== "Error") return error.name.toLowerCase().replace(/[^a-z0-9_]+/gu, "_");
  return "operator_action_failed";
}
