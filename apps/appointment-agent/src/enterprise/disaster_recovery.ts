/** Explicit disaster-recovery contract and rebuild-order validation. */

/** Approved recovery objectives and external evidence inputs. */
export interface DisasterRecoveryConfig {
  rpo_minutes: number;
  rto_minutes: number;
  backup_reference: string;
  restore_tested_at_iso: string;
  region: string;
}

/** Safe failure when DR objectives or evidence are incomplete. */
export class DisasterRecoveryConfigurationError extends Error {
  readonly code = "disaster_recovery_configuration_invalid";

  /** Create a sanitized configuration failure. */
  constructor() {
    super("disaster-recovery-configuration-invalid");
    this.name = "DisasterRecoveryConfigurationError";
  }
}

/** Validate a DR contract before a deployment can claim recoverability. */
export function validate_disaster_recovery_config(value: unknown): DisasterRecoveryConfig {
  if (typeof value !== "object" || value === null) throw new DisasterRecoveryConfigurationError();
  const record = value as Record<string, unknown>;
  const config: DisasterRecoveryConfig = {
    rpo_minutes: positive_integer(record.rpo_minutes),
    rto_minutes: positive_integer(record.rto_minutes),
    backup_reference: safe_text(record.backup_reference),
    restore_tested_at_iso: valid_timestamp(record.restore_tested_at_iso),
    region: safe_text(record.region),
  };
  if (config.rto_minutes < config.rpo_minutes) throw new DisasterRecoveryConfigurationError();
  return config;
}

/** Return the dependency-safe rebuild order used by the DR runbook. */
export function recovery_rebuild_order(): readonly string[] {
  return Object.freeze([
    "restore_database_and_verify_migration_state",
    "rotate_provider_credentials",
    "start_http_health_endpoint",
    "start_worker_with_disabled_autodrain",
    "reconcile_calendar_and_outbound_ledgers",
    "resume_tenant_traffic_after_slo_checks",
  ]);
}

function positive_integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 100_000) {
    throw new DisasterRecoveryConfigurationError();
  }
  return value;
}

function safe_text(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new DisasterRecoveryConfigurationError();
  }
  return value;
}

function valid_timestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new DisasterRecoveryConfigurationError();
  return new Date(Date.parse(value)).toISOString();
}
