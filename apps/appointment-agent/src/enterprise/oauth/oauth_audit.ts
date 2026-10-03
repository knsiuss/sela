/**
 * Redaction-safe audit events for OAuth, session, and grant operations.
 *
 * Every field here is drawn from a closed vocabulary: an event name, a stable
 * outcome code, a tenant, and an IdP. There is deliberately no field for a
 * token, authorization code, state value, nonce, PKCE verifier, email address,
 * Google account identifier, or client secret, so a caller cannot accidentally
 * log one. `assert_redacted_oauth_event` re-checks that invariant at runtime
 * because it is the control that keeps the redaction tests meaningful.
 */

import type { MetricsSink } from "../../observability/metrics.js";
import type { SecretAccessEvent, SecretAccessSink } from "../../security/secret_manager.js";
import type { OAuthFlowErrorCode } from "./oauth_error.js";

/** Closed set of auditable operations; adding one is a deliberate change. */
export type OAuthAuditEvent =
  | "authorize_request"
  | "authorize_callback"
  | "session_established"
  | "session_revoked"
  | "session_rejected"
  | "calendar_consent_request"
  | "calendar_grant_stored"
  | "calendar_grant_revoked"
  | "staff_directory_read";

/** Bounded outcome codes; the event name plus outcome is the whole signal. */
export type OAuthAuditOutcome =
  | "ok"
  | "missing"
  | "unknown"
  | "expired"
  | "replayed"
  | "denied"
  | "failed"
  | "not_allowed"
  | "revoked";

/** One PII-free OAuth audit record. */
export interface OAuthAuditRecord {
  event: OAuthAuditEvent;
  outcome: OAuthAuditOutcome;
  /** Owning tenant when the operation is tenant-scoped. */
  tenant_id?: string;
  /** Identity provider the operation was bound to. */
  idp?: "supabase" | "google";
  /** ISO timestamp of the operation. */
  at: string;
}

/** Sink for OAuth audit records. */
export interface OAuthAuditSink {
  /**
   * Record one PII-free OAuth audit event.
   *
   * @param record - Event carrying only controlled vocabulary and identifiers.
   */
  record(record: OAuthAuditRecord): void;
}

/** In-memory sink for tests and local composition. */
export class InMemoryOAuthAuditSink implements OAuthAuditSink {
  /** Recorded events in arrival order. */
  readonly records: OAuthAuditRecord[] = [];

  /**
   * Append a defensive copy of one audit record.
   *
   * @param record - PII-free OAuth audit event.
   */
  record(record: OAuthAuditRecord): void {
    this.records.push({ ...record });
  }
}

const EVENT_NAMES: ReadonlySet<string> = new Set<OAuthAuditEvent>([
  "authorize_request",
  "authorize_callback",
  "session_established",
  "session_revoked",
  "session_rejected",
  "calendar_consent_request",
  "calendar_grant_stored",
  "calendar_grant_revoked",
  "staff_directory_read",
]);

const OUTCOME_NAMES: ReadonlySet<string> = new Set<OAuthAuditOutcome>([
  "ok", "missing", "unknown", "expired", "replayed", "denied", "failed", "not_allowed", "revoked",
]);

/** Substrings that must never appear in an audit record field value. */
const FORBIDDEN_SUBSTRINGS: readonly string[] = [
  "ya29.", "1//", "eyJ", "code=", "state=", "nonce=", "access_token", "refresh_token",
  "id_token", "client_secret", "@",
];

/**
 * Assert that one audit record carries no secret-shaped or PII-shaped value.
 *
 * @param record - Record about to be emitted.
 * @throws TypeError when a field is outside the controlled vocabulary or
 * contains a token marker, an email-like value, or a control character.
 */
export function assert_redacted_oauth_event(record: OAuthAuditRecord): void {
  if (!EVENT_NAMES.has(record.event) || !OUTCOME_NAMES.has(record.outcome)) {
    throw new TypeError("oauth-audit-vocabulary-invalid");
  }
  if (typeof record.at !== "string" || !Number.isFinite(Date.parse(record.at))) {
    throw new TypeError("oauth-audit-vocabulary-invalid");
  }
  if (record.idp !== undefined && record.idp !== "supabase" && record.idp !== "google") {
    throw new TypeError("oauth-audit-vocabulary-invalid");
  }
  if (record.tenant_id !== undefined && !/^[1-9]\d{0,18}$/.test(record.tenant_id)) {
    throw new TypeError("oauth-audit-vocabulary-invalid");
  }
  for (const value of Object.values(record)) {
    if (typeof value !== "string") continue;
    const lowered = value.toLowerCase();
    if (/[\u0000-\u001f\u007f]/u.test(value) || FORBIDDEN_SUBSTRINGS.some((needle) => lowered.includes(needle))) {
      throw new TypeError("oauth-audit-value-not-redacted");
    }
  }
}

/**
 * Record one OAuth audit event and a bounded counter.
 *
 * Metric labels carry only the event and outcome enums, so label cardinality
 * stays fixed no matter how many tenants or subjects flow through.
 *
 * @param sink - Optional OAuth audit sink.
 * @param metrics - Optional bounded metrics sink.
 * @param record - PII-free audit record.
 * @throws TypeError when the record violates the redaction invariant.
 */
export function record_oauth_event(
  sink: OAuthAuditSink | undefined,
  metrics: MetricsSink | undefined,
  record: OAuthAuditRecord,
): void {
  assert_redacted_oauth_event(record);
  sink?.record({ ...record });
  metrics?.increment("oauth_flow_total", { event: record.event, outcome: record.outcome });
}

/**
 * Fold an OAuth failure code into a bounded audit outcome.
 *
 * @param code - Stable OAuth failure code.
 * @returns The matching audit outcome; unmapped codes become `failed`.
 */
export function outcome_for_error(code: OAuthFlowErrorCode): OAuthAuditOutcome {
  switch (code) {
    case "oauth_state_missing":
    case "oauth_session_unavailable":
      return "missing";
    case "oauth_state_unknown":
    case "oauth_state_malformed":
      return "unknown";
    case "oauth_state_expired":
      return "expired";
    case "oauth_state_replayed":
      return "replayed";
    case "oauth_redirect_not_allowed":
    case "oauth_return_path_invalid":
      return "not_allowed";
    case "oauth_membership_unresolved":
    case "oauth_tenant_mismatch":
    case "oauth_identity_unverified":
      return "denied";
    default:
      return "failed";
  }
}

/**
 * Project an OAuth event onto the existing secret-access audit vocabulary.
 *
 * Reusing `SecretAccessEvent` keeps one audit pipeline for credential-adjacent
 * operations instead of a second, divergent one.
 *
 * @param record - OAuth audit record to project.
 * @returns A secret-access-shaped event with the tenant preserved.
 */
export function as_secret_access_event(record: OAuthAuditRecord): SecretAccessEvent {
  assert_redacted_oauth_event(record);
  return {
    secret_ref: `oauth:${record.event}`,
    ...(record.tenant_id === undefined ? {} : { tenant_id: record.tenant_id }),
    operation: record.event.endsWith("_revoked") ? "revoke" : "read",
    result: record.outcome === "ok" ? "hit" : record.outcome === "denied" || record.outcome === "not_allowed" ? "revoked" : "miss",
    at: record.at,
  };
}

/** Sink type alias so callers can compose both audit vocabularies. */
export type OAuthSecretAuditSink = SecretAccessSink;