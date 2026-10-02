/**
 * Hybrid intent classification.
 *
 * REGEX FAST PATH: `classify_intent` is the only thing that may produce
 * `confirm` or `cancel`, and it never consults a model. Those two intents gate
 * the customer-confirmation boundary, so a probabilistic model must not be
 * able to reach them.
 *
 * LLM FALLBACK: only a message the regex path is not confident about is sent to
 * the model, and only an intent from a closed allow-list may come back.
 *
 * FAIL CLOSED: no configured model, a provider error, or an unparsable answer
 * all return the regex result unchanged, which is exactly today's behaviour.
 */

import {
  build_model_request,
  ModelPortError,
  type ModelPort,
  type ModelResponse,
} from "@repo/llm";
import { classify_intent } from "../guardrails.js";
import type { Intent } from "../state.js";

/** Regex path confidence at or above which the model is never consulted. */
export const REGEX_LOW_CONFIDENCE = 0.7;

/** Upper bound on confidence any model may assert; keeps the gate meaningful. */
export const MAX_MODEL_CONFIDENCE = 0.85;

/** Confidence assigned when the model declines to classify. */
export const UNKNOWN_CONFIDENCE = 0.3;

/** Per-call deadline for a classification request. */
export const CLASSIFIER_TIMEOUT_MS = 2_000;

/** Assistant tokens requested for a one-intent classification. */
export const CLASSIFIER_MAX_OUTPUT_TOKENS = 128;

/**
 * Upper bound on provider text scanned for JSON.
 *
 * An oversized answer is treated as unusable instead of being truncated, since
 * a cut-off JSON object cannot be trusted and the fail-closed path already
 * handles this case.
 */
export const MAX_MODEL_TEXT_LENGTH = 8_192;

/**
 * Intents the regex path owns exclusively.
 *
 * `confirm` and `cancel` gate the customer-confirmation and destructive-action
 * boundaries, so `Intent` minus these two is exactly the set a model may
 * propose. Deriving it from {@link Intent} keeps `state.ts` the single source
 * of truth: adding an intent to the union cannot silently widen what a model
 * may assert, because the compiler rejects the list below if it drifts.
 */
export type ModelAllowedIntent = Exclude<Intent, "confirm" | "cancel">;

/**
 * The closed allow-list a model proposal must match.
 *
 * Annotation (not `as const`) is deliberate: it is what proves the list is a
 * subset of {@link ModelAllowedIntent}, so adding an intent to `state.ts`
 * without deciding its model reachability fails the build.
 */
export const MODEL_ALLOWED_INTENTS: readonly ModelAllowedIntent[] = [
  "book",
  "reschedule",
  "greet",
  "unknown",
];

/**
 * Intents the model may never propose under any circumstance.
 *
 * `confirm_move` is a validated button action carrying a session generation
 * (`reschedule/button_actions.ts`), not a text intent: a message can never
 * advance the calendar write. This deny-list is applied in addition to the
 * allow-list so a future widening of the allow-list still cannot reach it.
 */
export const MODEL_FORBIDDEN_INTENTS = ["confirm_move", "confirm", "cancel", "approve", "authorize"] as const;

/** Where a classified intent came from; recorded in metrics only. */
export type ClassificationSource = "regex" | "model";

/** One classified turn plus its provenance. */
export interface HybridClassifiedIntent {
  intent: Intent;
  confidence: number;
  source: ClassificationSource;
  /** Stable PII-free reason when the model path degraded. */
  fallback_reason?: string;
}

/** Raw model classification shape; validated before it reaches the domain. */
export interface ModelIntentProposal {
  intent: string;
  confidence: number;
  reason?: string;
}

/** Deterministic regex classifier result, injected so tests can pin it. */
export type RegexClassifier = (message: string) => { intent: Intent; confidence: number };

/** Dependencies for one hybrid classifier. */
export interface HybridClassifierOptions {
  /** Model seam; omit it to keep the pre-LLM behaviour exactly. */
  model?: ModelPort;
  /** Existing regex classifier; defaults to the guardrails implementation. */
  regex_classifier?: RegexClassifier;
  /** Bounded metrics seam. Labels must never carry message content. */
  metrics?: ClassifierMetricsSink;
}

/** Minimal metrics seam so the classifier stays framework-free. */
export interface ClassifierMetricsSink {
  increment(name: string, labels?: Readonly<Record<string, string>>): void;
}

/** Regex-only classifier injected by the composition root. */
export type RegexClassifierProvider = () => RegexClassifier;

/**
 * Classify one message, consulting the model only when regex is unsure.
 *
 * @param message - Raw customer text; never logged by this function.
 * @param options - Model seam, regex override, and metrics sink.
 * @returns The chosen intent, bounded confidence, and its source.
 * @throws ModelPortError When the message exceeds the outbound prompt bound.
 */
export async function classify_intent_hybrid(
  message: string,
  options: HybridClassifierOptions,
): Promise<HybridClassifiedIntent> {
  const regex_classifier = options.regex_classifier ?? classify_intent;
  const regex_result = regex_classifier(message);
  if (regex_result.intent !== "unknown" || regex_result.confidence >= REGEX_LOW_CONFIDENCE) {
    return { ...regex_result, source: "regex" };
  }
  const model = options.model;
  if (model === undefined || !model.is_configured()) {
    return degrade(regex_result, "model-not-configured", options);
  }
  try {
    // Built through the port's own validator so the message is PII-scrubbed
    // before it can reach a provider. The adapter re-validates too; this call
    // is what makes the guarantee visible at the call site that owns the text.
    const request = build_model_request({
      user_text: message,
      max_output_tokens: CLASSIFIER_MAX_OUTPUT_TOKENS,
      timeout_ms: CLASSIFIER_TIMEOUT_MS,
    });
    return accept_model_result(await model.complete(request), regex_result, options);
  } catch (error) {
    return degrade(regex_result, error_reason(error), options);
  }
}

function accept_model_result(
  response: ModelResponse,
  regex_result: { intent: Intent; confidence: number },
  options: HybridClassifierOptions,
): HybridClassifiedIntent {
  const proposal = parse_model_proposal(response.text);
  if (proposal === undefined) return degrade(regex_result, "model-output-invalid", options);
  if (is_forbidden_intent(proposal.intent)) {
    return degrade(regex_result, "model-intent-forbidden", options);
  }
  if (!is_allowed_intent(proposal.intent)) {
    return degrade(regex_result, "model-intent-not-allowed", options);
  }
  const intent: Intent = proposal.intent;
  if (intent === "unknown") {
    record(options, "model", intent, "declined");
    return { intent: "unknown", confidence: UNKNOWN_CONFIDENCE, source: "model" };
  }
  const confidence = bound_confidence(proposal.confidence);
  record(options, "model", intent, "accepted");
  return { intent, confidence, source: "model" };
}

function degrade(
  regex_result: { intent: Intent; confidence: number },
  reason: string,
  options: HybridClassifierOptions,
): HybridClassifiedIntent {
  record(options, "regex", regex_result.intent, reason);
  return { ...regex_result, source: "regex", fallback_reason: reason };
}

/**
 * Emit one classification metric.
 *
 * Every label value is a bounded constant drawn from the intent union or the
 * fixed reason set, so a message, recipient, or credential can never become a
 * metric label and blow up cardinality.
 */
function record(
  options: HybridClassifierOptions,
  source: ClassificationSource,
  intent: Intent,
  result: string,
): void {
  options.metrics?.increment("intent_classification_total", { source, intent, result });
}

/**
 * Map a thrown value onto a fixed, PII-free reason label.
 *
 * @param error - Whatever the model seam threw; never rethrown.
 * @returns A stable reason string safe to use as a metric label.
 */
function error_reason(error: unknown): string {
  if (error instanceof ModelPortError) return error.code;
  return "model-error";
}

/**
 * Extract the first balanced JSON object from untrusted model text.
 *
 * Provider output is prose-wrapped in practice ("Sure! {json}"), so the parser
 * locates the first JSON structural character and hands a balanced run to
 * `JSON.parse`. Brace counting is string-aware so a brace inside a quoted
 * value does not end the object early.
 *
 * An array is rejected rather than unwrapped. A model asked for one object
 * that answered with a list has not understood the contract, and picking an
 * element out of it would be guessing on an untrusted value — the caller
 * degrades to the regex result instead. A bare primitive or unbalanced input
 * likewise yields undefined, because an unparsable answer is a normal provider
 * outcome that must degrade, not crash.
 *
 * @param text - Raw untrusted provider output.
 * @returns The parsed object, or undefined when the text is not one object.
 */
export function parse_json_candidate(text: string): unknown {
  if (text.length > MAX_MODEL_TEXT_LENGTH) return undefined;
  const start = first_json_index(text);
  if (start < 0 || text[start] !== "{") return undefined;
  let depth = 0;
  let in_string = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (in_string) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') in_string = false;
      continue;
    }
    if (char === '"') in_string = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, index + 1)) as unknown;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/**
 * Locate the first `{` or `[` that is not inside a quoted run.
 *
 * @param text - Raw untrusted provider output.
 * @returns Index of the first JSON structural character, or -1 when absent.
 */
function first_json_index(text: string): number {
  let in_string = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (in_string) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') in_string = false;
      continue;
    }
    if (char === '"') in_string = true;
    else if (char === "{" || char === "[") return index;
  }
  return -1;
}

/**
 * Parse model text into a validated proposal.
 *
 * Only the first JSON object in the text is considered, so a model that adds a
 * trailing sentence does not fail the whole turn. Any other shape is invalid.
 *
 * @param text - Raw untrusted provider output.
 * @returns The proposal, or undefined when the text is not a valid object.
 */
export function parse_model_proposal(text: string): ModelIntentProposal | undefined {
  const parsed = parse_json_candidate(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const candidate = parsed as Record<string, unknown>;
  const intent = candidate["intent"];
  const confidence = candidate["confidence"];
  if (typeof intent !== "string" || typeof confidence !== "number") return undefined;
  if (!Number.isFinite(confidence)) return undefined;
  const reason = candidate["reason"];
  return {
    intent: intent.trim().toLowerCase(),
    confidence,
    ...(typeof reason === "string" ? { reason: reason.slice(0, 200) } : {}),
  };
}

/**
 * Clamp a model-asserted confidence into the honest range.
 *
 * A model reporting 1.0 is treated as a high-confidence guess rather than a
 * certainty, because no probabilistic classifier deserves perfect trust.
 *
 * @param confidence - Model-asserted value from 0 through 1.
 * @returns A value inside `(0, MAX_MODEL_CONFIDENCE]`.
 */
export function bound_confidence(confidence: number): number {
  if (!Number.isFinite(confidence)) return UNKNOWN_CONFIDENCE;
  if (confidence <= 0) return UNKNOWN_CONFIDENCE;
  return Math.min(confidence, MAX_MODEL_CONFIDENCE);
}

/**
 * True only for an intent on the model allow-list.
 *
 * This is a type guard, so callers get `ModelAllowedIntent` narrowing from an
 * untrusted `string` without a cast. That is what keeps a model answer from
 * ever widening `Intent`.
 *
 * @param intent - Trimmed, lower-cased intent parsed out of model output.
 * @returns True only when the intent is one a model may propose.
 */
export function is_allowed_intent(intent: string): intent is ModelAllowedIntent {
  return (MODEL_ALLOWED_INTENTS as readonly string[]).includes(intent);
}

/**
 * True for any intent the model is never permitted to produce.
 *
 * Matching is prefix-based on purpose. `confirm_move` alone is not a value
 * that appears on the wire: the real button action is generation-suffixed
 * (`confirm_move_g1`, see `reschedule/button_actions.ts`), so an exact-match
 * deny-list would wave the actual dangerous string straight through.
 *
 * @param intent - Trimmed, lower-cased intent parsed out of model output.
 * @returns True when the intent is a denied value or a denied stem with an
 *   action suffix such as `_g1`.
 */
export function is_forbidden_intent(intent: string): boolean {
  return MODEL_FORBIDDEN_INTENTS.some(
    (forbidden) => intent === forbidden || intent.startsWith(`${forbidden}_`),
  );
}