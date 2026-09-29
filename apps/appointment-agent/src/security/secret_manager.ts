/** Secret-manager port with an env-backed adapter and PII-free access audit. */

import type { MetricsSink } from "../observability/metrics.js";

/** Audited secret operations; values are never recorded. */
export type SecretAccessOperation = "read" | "revoke";

/** Audited secret outcomes; values are never recorded. */
export type SecretAccessResult = "hit" | "miss" | "revoked";

/** One secret access event naming configuration only, never values. */
export interface SecretAccessEvent {
  /** Environment-style reference name, for example WHATSAPP_API_TOKEN. */
  secret_ref: string;
  /** Owning tenant when the access is tenant-scoped. */
  tenant_id?: string;
  operation: SecretAccessOperation;
  result: SecretAccessResult;
  /** ISO timestamp of the access. */
  at: string;
}

/** Minimal sink for secret access audit events. */
export interface SecretAccessSink {
  /**
   * Record one PII-free secret access event.
   *
   * @param event - Event carrying refs and outcomes only.
   */
  record(event: SecretAccessEvent): void;
}

/** In-memory audit sink for tests and local composition. */
export class InMemorySecretAccessSink implements SecretAccessSink {
  /** Recorded events in arrival order. */
  readonly events: SecretAccessEvent[] = [];

  /**
   * Append a defensive copy of one audit event.
   *
   * @param event - PII-free secret access event.
   */
  record(event: SecretAccessEvent): void {
    this.events.push({ ...event });
  }
}

/** Stable fail-closed codes; messages name refs, never values. */
export type SecretManagerCode =
  | "secret-ref-invalid"
  | "secret-mapping-invalid"
  | "secret-not-configured"
  | "secret-revoked";

/** Fail-closed secret access error that never contains a secret value. */
export class SecretManagerError extends Error {
  /** Stable machine-readable failure code. */
  readonly code: SecretManagerCode;

  /**
   * Create a sanitized secret-manager error.
   *
   * @param code - Stable failure code safe for logs and metrics.
   */
  constructor(code: SecretManagerCode) {
    super(`secret-manager-failed: ${code}`);
    this.name = "SecretManagerError";
    this.code = code;
  }
}

/** Narrow port for runtime secret resolution. */
export interface SecretManager {
  /**
   * Resolve one secret value by reference.
   *
   * @param ref - Allow-listed reference name, never a value.
   * @returns The secret value for immediate use; callers must not log it.
   * @throws SecretManagerError when the ref is unknown or unconfigured.
   */
  get_secret(ref: string): string;
}

const SECRET_REF_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;

/**
 * Env-backed SecretManager for the current deployment stage.
 *
 * Only explicitly allow-listed references resolve; anything else fails
 * closed. This adapter is the port boundary where a managed secret provider
 * replaces process environment without changing callers.
 */
export class EnvSecretManager implements SecretManager {
  private readonly env: Record<string, string | undefined>;
  private readonly allowed_refs: ReadonlySet<string>;

  /**
   * Create the env-backed adapter.
   *
   * @param env - Environment mapping; defaults to process environment.
   * @param allowed_refs - Exact reference names permitted to resolve.
   */
  constructor(
    env: Record<string, string | undefined> = process.env,
    allowed_refs: ReadonlySet<string> = new Set(),
  ) {
    this.env = env;
    this.allowed_refs = allowed_refs;
  }

  /**
   * Resolve one allow-listed reference from the environment.
   *
   * @param ref - Reference name validated against the allow list.
   * @returns The configured secret value.
   * @throws SecretManagerError for unknown refs or missing values.
   */
  get_secret(ref: string): string {
    const name = require_ref(ref);
    if (!this.allowed_refs.has(name)) throw new SecretManagerError("secret-ref-invalid");
    const value = this.env[name];
    if (value === undefined || value === "") throw new SecretManagerError("secret-not-configured");
    return value;
  }
}

/** Decorator emitting audit events and metrics without touching values. */
export class AuditedSecretManager implements SecretManager {
  private readonly inner: SecretManager;
  private readonly sink: SecretAccessSink | undefined;
  private readonly metrics: MetricsSink | undefined;
  private readonly clock: () => Date;

  /**
   * Create the auditing decorator.
   *
   * @param inner - Underlying secret manager.
   * @param sink - Optional audit sink for access events.
   * @param metrics - Optional bounded metrics sink.
   * @param clock - Injectable clock for deterministic tests.
   */
  constructor(
    inner: SecretManager,
    sink?: SecretAccessSink,
    metrics?: MetricsSink,
    clock: () => Date = () => new Date(),
  ) {
    this.inner = inner;
    this.sink = sink;
    this.metrics = metrics;
    this.clock = clock;
  }

  /**
   * Resolve one secret while auditing the outcome.
   *
   * @param ref - Allow-listed reference name.
   * @returns The secret value for immediate use.
   * @throws SecretManagerError after recording the miss.
   */
  get_secret(ref: string): string {
    try {
      const value = this.inner.get_secret(ref);
      record_secret_access(this.sink, this.metrics, {
        secret_ref: safe_ref(ref),
        operation: "read",
        result: "hit",
        at: this.clock().toISOString(),
      });
      return value;
    } catch (error) {
      record_secret_access(this.sink, this.metrics, {
        secret_ref: safe_ref(ref),
        operation: "read",
        result: error instanceof SecretManagerError && error.code === "secret-revoked" ? "revoked" : "miss",
        at: this.clock().toISOString(),
      });
      throw error;
    }
  }
}

/**
 * Record one secret access event and counter without secret values.
 *
 * Metric labels carry only the bounded operation/result enums; the ref and
 * tenant stay in the audit event to avoid metric cardinality growth.
 *
 * @param sink - Optional audit sink.
 * @param metrics - Optional bounded metrics sink.
 * @param event - PII-free access event.
 */
export function record_secret_access(
  sink: SecretAccessSink | undefined,
  metrics: MetricsSink | undefined,
  event: SecretAccessEvent,
): void {
  sink?.record({ ...event });
  metrics?.increment("secret_access_total", {
    operation: event.operation,
    result: event.result,
  });
}

/**
 * Validate a secret reference name.
 *
 * @param ref - Untrusted reference input.
 * @returns The validated reference name.
 * @throws SecretManagerError when the format is invalid.
 */
export function require_ref(ref: string): string {
  if (typeof ref !== "string" || !SECRET_REF_PATTERN.test(ref)) {
    throw new SecretManagerError("secret-ref-invalid");
  }
  return ref;
}

/** Render a ref for audit events without ever echoing a value. */
function safe_ref(ref: string): string {
  return typeof ref === "string" && SECRET_REF_PATTERN.test(ref) ? ref : "invalid-ref";
}
