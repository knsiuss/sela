/**
 * Local gateway over the real audited operator-action contract.
 *
 * The dashboard mirrors `POST /v1/operator/actions`: an action request is
 * authorized by the real `OperatorActionService`, executed by a local handler,
 * and appended to an append-only audit store. Nothing here re-implements the
 * action-to-permission mapping, which is private to `operator_actions.ts`;
 * capability hints come from the service's own side-effect-free preflight.
 *
 * SECURITY: no authentication exists yet, so the acting principal is the local
 * synthetic one and authorization outcomes are only as trustworthy as that
 * principal. Until the OIDC path and server wiring land, this gateway must stay
 * on loopback.
 */

import {
  AuthorizationError,
  type AuthenticatedPrincipal,
} from "appointment-agent/dist/src/enterprise/authorization.js";
import {
  InMemoryOperatorActionAudit,
  OperatorActionService,
  type OperatorAction,
  type OperatorActionAuditStore,
  type OperatorActionHandler,
  type OperatorActionRequest,
} from "appointment-agent/dist/src/enterprise/operator_actions.js";

export type { OperatorAction, OperatorActionRequest };

/** Every action the audited boundary exposes, in display order. */
export const OPERATOR_ACTIONS: readonly OperatorAction[] = [
  "resolve_conflict", "release_hold", "reconcile_orphan", "replay_outbound", "export_audit",
];

/** Bounded reason codes; the dashboard never accepts free-text reasons. */
export const OPERATOR_ACTION_REASON_CODES = [
  "operator_verified", "calendar_recovered", "ledger_reconciled", "transport_retry", "audit_request",
] as const;

/** One bounded reason code selectable in the action panel. */
export type OperatorActionReasonCode = (typeof OPERATOR_ACTION_REASON_CODES)[number];

/** Target identifiers the local workspace can act on. */
export interface LocalActionTargets {
  conflict_ids: readonly string[];
  queue_item_ids: readonly string[];
}

/** An appended audit row with the timestamp the domain store does not carry. */
export interface StampedAuditRecord {
  tenant_id: string;
  actor_subject: string;
  action: OperatorAction;
  target_id: string;
  outcome: "succeeded" | "denied" | "failed";
  request_id: string;
  reason_code?: string;
  at_iso: string;
}

/** An append-only audit store that stamps arrival time. */
export interface StampingAuditStore extends OperatorActionAuditStore {
  readonly records: readonly StampedAuditRecord[];
}

/** Result of one attempted action, mirroring the HTTP response envelope. */
export interface OperatorActionOutcome {
  status: "succeeded" | "denied" | "failed";
  action: OperatorAction;
  target_id: string;
  /** Domain authorization code or sanitized failure code; null on success. */
  code: string | null;
}

/** Failure raised when the local workspace cannot resolve an action target. */
export class OperatorActionUnavailableError extends Error {
  readonly code = "operator-action-target-not-found";

  /** Create a sanitized target-resolution failure. */
  constructor() {
    super("operator-action-target-not-found");
    this.name = "OperatorActionUnavailableError";
  }
}

/**
 * Create an audit store that records arrival time alongside the domain fields.
 *
 * @param clock - Injectable clock so tests stay deterministic.
 * @returns Append-only store whose rows also carry `at_iso`.
 */
export function create_stamping_audit_store(clock: () => Date = () => new Date()): StampingAuditStore {
  const base = new InMemoryOperatorActionAudit();
  const stamped: StampedAuditRecord[] = [];
  return {
    get records(): readonly StampedAuditRecord[] {
      return stamped;
    },
    async record(input): Promise<void> {
      await base.record(input);
      stamped.push({ ...input, at_iso: clock().toISOString() });
    },
  };
}

/**
 * Build the action service used by the dashboard.
 *
 * @param audit - Append-only audit store.
 * @param targets - Identifiers the local workspace recognises.
 * @returns Service whose handler refuses unknown targets instead of no-oping.
 */
export function create_local_action_service(
  audit: OperatorActionAuditStore,
  targets: LocalActionTargets,
): OperatorActionService {
  const handler: OperatorActionHandler = (request) => {
    if (!is_known_target(targets, request.target_id)) throw new OperatorActionUnavailableError();
    return Promise.resolve();
  };
  return new OperatorActionService(audit, handler);
}

/**
 * Ask the real service whether a request would be authorized.
 *
 * @param service - Configured operator action service.
 * @param request - Candidate request.
 * @returns Null when allowed, otherwise the authorization error code.
 */
export function can_run_operator_action(
  service: OperatorActionService,
  request: OperatorActionRequest,
): string | null {
  try {
    service.authorize(request);
    return null;
  } catch (error) {
    return error instanceof AuthorizationError ? error.code : "operator-action-preflight-failed";
  }
}

/**
 * Execute one action through the audited contract.
 *
 * @param service - Configured operator action service.
 * @param request - Request to execute.
 * @returns Outcome envelope; failures carry a stable code and never throw.
 */
export async function run_operator_action(
  service: OperatorActionService,
  request: OperatorActionRequest,
): Promise<OperatorActionOutcome> {
  try {
    const result = await service.execute(request);
    return { status: result.outcome, action: result.action, target_id: result.target_id, code: null };
  } catch (error) {
    // Mirror the domain rule that only an authorization failure is a denial;
    // anything else is a failure, so the audit row and the UI agree.
    const status = error instanceof AuthorizationError ? "denied" : "failed";
    return { status, action: request.action, target_id: request.target_id, code: failure_code(error) };
  }
}

/**
 * Build a validated action request with a server-side request id.
 *
 * @param input - Principal, tenant, action, target, and bounded reason.
 * @returns Request the real service will normalize and audit.
 * @throws TypeError When no cryptographically strong request id is available.
 */
export function build_operator_action_request(input: {
  principal: AuthenticatedPrincipal;
  tenant_id: string;
  action: OperatorAction;
  target_id: string;
  reason: OperatorActionReasonCode;
}): OperatorActionRequest {
  return {
    principal: input.principal,
    tenant_id: input.tenant_id,
    action: input.action,
    target_id: input.target_id,
    request_id: create_request_id(),
    reason: input.reason,
  };
}

/** Human label for an action outcome. */
export function outcome_label(status: OperatorActionOutcome["status"]): string {
  if (status === "succeeded") return "Succeeded";
  if (status === "denied") return "Denied";
  return "Failed";
}

/** Return a collision-free request id or fail fast rather than guess one. */
function create_request_id(): string {
  const webcrypto = globalThis.crypto;
  if (webcrypto === undefined || typeof webcrypto.randomUUID !== "function") {
    throw new TypeError("operator-action-request-id-unavailable");
  }
  return webcrypto.randomUUID();
}

function is_known_target(targets: LocalActionTargets, target_id: string): boolean {
  return targets.conflict_ids.includes(target_id) || targets.queue_item_ids.includes(target_id);
}

function failure_code(error: unknown): string {
  if (error instanceof AuthorizationError) return error.code;
  if (error instanceof Error && error.name !== "Error") {
    return error.name.toLowerCase().replace(/[^a-z0-9_]+/gu, "_");
  }
  return "operator_action_failed";
}