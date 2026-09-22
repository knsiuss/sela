/**
 * Guardrails placeholder.
 *
 * Shared policy checks (PII redaction, human-in-the-loop gates) live here
 * once a second consumer needs them (see ADR 0001 consequences). Until then
 * this package only reserves the boundary so apps never import policy logic
 * from each other.
 */

/** Minimal verdict returned by every guardrail check. */
export interface GuardrailVerdict {
  allowed: boolean;
  reason?: string;
}

/**
 * Placeholder check that allows everything.
 *
 * TODO(backend): extract the real PII redaction and HITL gates from
 * `apps/appointment-agent` when the second adapter lands.
 *
 * @param _input: Unused until the real checks are extracted.
 * @returns An allow-all verdict.
 */
export function check_guardrails(_input: unknown): GuardrailVerdict {
  return { allowed: true };
}
