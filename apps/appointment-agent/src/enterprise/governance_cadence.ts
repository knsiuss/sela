/** Named governance cadence tunables: evidence export and access review. */

/** Default evidence export cadence in days. */
export const EVIDENCE_EXPORT_CADENCE_DAYS = 7;

/** Default access-review cadence in days. */
export const ACCESS_REVIEW_CADENCE_DAYS = 90;

/** Default retention-check cadence in hours. */
export const EVIDENCE_RETENTION_CHECK_HOURS = 24;

/** Governance cadence windows. */
export interface GovernanceCadence {
  evidence_export_days: number;
  access_review_days: number;
  retention_check_hours: number;
}

/** Frozen defaults aligned with the retention evidence contract. */
export const DEFAULT_GOVERNANCE_CADENCE: GovernanceCadence = Object.freeze({
  evidence_export_days: EVIDENCE_EXPORT_CADENCE_DAYS,
  access_review_days: ACCESS_REVIEW_CADENCE_DAYS,
  retention_check_hours: EVIDENCE_RETENTION_CHECK_HOURS,
});

/**
 * Resolve caller-supplied cadence against named tunable defaults.
 *
 * @param input - Partial cadence overrides.
 * @returns Fully resolved cadence.
 */
export function resolve_governance_cadence(input: Partial<GovernanceCadence> = {}): GovernanceCadence {
  if (typeof input !== "object" || input === null) throw new TypeError("governance-cadence-invalid");
  return {
    evidence_export_days: days(input.evidence_export_days ?? EVIDENCE_EXPORT_CADENCE_DAYS, "evidence_export_days"),
    access_review_days: days(input.access_review_days ?? ACCESS_REVIEW_CADENCE_DAYS, "access_review_days"),
    retention_check_hours: hours(input.retention_check_hours ?? EVIDENCE_RETENTION_CHECK_HOURS),
  };
}

/**
 * Return true when an evidence export is due.
 *
 * @param last_export_iso - Last export time, or null when never exported.
 * @param now - Reference time.
 * @param cadence - Resolved cadence.
 * @returns True when due.
 */
export function is_evidence_export_due(
  last_export_iso: string | null,
  now: Date,
  cadence: GovernanceCadence = DEFAULT_GOVERNANCE_CADENCE,
): boolean {
  if (last_export_iso === null) return true;
  const last_ms = Date.parse(last_export_iso);
  if (!Number.isFinite(last_ms)) throw new TypeError("governance-last-export-invalid");
  return now.getTime() - last_ms >= cadence.evidence_export_days * 86_400_000;
}

/**
 * Return true when an access review is due.
 *
 * @param last_review_iso - Last review time, or null when never reviewed.
 * @param now - Reference time.
 * @param cadence - Resolved cadence.
 * @returns True when due.
 */
export function is_access_review_due(
  last_review_iso: string | null,
  now: Date,
  cadence: GovernanceCadence = DEFAULT_GOVERNANCE_CADENCE,
): boolean {
  if (last_review_iso === null) return true;
  const last_ms = Date.parse(last_review_iso);
  if (!Number.isFinite(last_ms)) throw new TypeError("governance-last-review-invalid");
  return now.getTime() - last_ms >= cadence.access_review_days * 86_400_000;
}

/**
 * Render quotable English lines describing the cadence.
 *
 * @param cadence - Resolved or partial cadence.
 * @returns One sentence per cadence window.
 */
export function governance_cadence_statement(cadence: Partial<GovernanceCadence> = {}): string[] {
  const resolved = resolve_governance_cadence(cadence);
  return [
    `Audit evidence is exported every ${resolved.evidence_export_days} days.`,
    `Access reviews are completed every ${resolved.access_review_days} days.`,
    `Retention eligibility is checked every ${resolved.retention_check_hours} hours.`,
  ];
}

function days(value: number, field_name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 3650) throw new TypeError(`governance-${field_name}-invalid`);
  return value;
}

function hours(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 8760) throw new TypeError("governance-retention_check_hours-invalid");
  return value;
}
