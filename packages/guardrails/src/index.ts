/**
 * Guardrails boundary (no implementation yet).
 *
 * The single owner of human-handoff policy today is
 * `apps/appointment-agent/src/handoff.ts` (deny-list detection) plus
 * `guardrails.ts` (confidence gate). Those stay in the app until a second
 * app or package needs them, per ADR 0001 "extract on second use".
 *
 * This package therefore exports types only. A fail-open runtime check was
 * removed during the Sep 2026 dedup audit because an allow-all verdict is
 * more dangerous than a missing symbol: a future caller would treat it as a
 * working safety gate.
 *
 * When extraction happens, move the deny-list detector here unchanged and
 * keep `apps/appointment-agent/src/handoff.ts` as a thin re-export so the
 * policy has exactly one definition.
 */

/** Minimal verdict returned by every guardrail check. */
export interface GuardrailVerdict {
  allowed: boolean;
  reason?: string;
}
