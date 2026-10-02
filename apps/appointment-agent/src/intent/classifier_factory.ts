/**
 * Composition root for the model-backed intent classifier.
 *
 * The model is opt-in twice over: `LLM_PROVIDER` must name a provider that is
 * implemented, and the adapter must report itself configured. Anything else
 * yields no classifier at all, which leaves the agent on the regex fast path
 * with today's fail-closed escalation.
 */

import { build_model_from_env, SUPPORTED_PROVIDERS, type ModelPort } from "@repo/llm";
import {
  classify_intent_hybrid,
  type ClassifierMetricsSink,
  type HybridClassifierOptions,
} from "./hybrid_classifier.js";
import type { Intent } from "../state.js";

/** Environment variable selecting a model provider; empty means disabled. */
export const LLM_PROVIDER_ENV = "LLM_PROVIDER";

/** Providers this build actually implements. */
export const SUPPORTED_LLM_PROVIDERS = SUPPORTED_PROVIDERS;

/** Options for resolving the classifier used by one composition. */
export interface BuildIntentClassifierOptions {
  env?: Record<string, string | undefined>;
  metrics?: ClassifierMetricsSink;
  /** Injected port; used by tests and by a deployment that owns its own adapter. */
  model?: ModelPort;
}

/**
 * Build the async classifier the graph will call.
 *
 * The returned type is the graph's own `IntentClassifier` shape, so `Intent`
 * from `state.ts` stays the single source of truth and no caller has to widen
 * or re-narrow the intent at the seam.
 *
 * @param options - Environment, metrics sink, and optional injected port.
 * @returns A classifier that consults a model only for low-confidence input.
 */
export function build_intent_classifier(
  options: BuildIntentClassifierOptions = {},
): (message: string) => Promise<{ intent: Intent; confidence: number }> {
  const env = options.env ?? process.env;
  const model = options.model ?? resolve_model_port(env);
  const classifier_options: HybridClassifierOptions = {
    ...(model === undefined ? {} : { model }),
    ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
  };
  return async (message: string) => {
    const result = await classify_intent_hybrid(message, classifier_options);
    return { intent: result.intent, confidence: result.confidence };
  };
}

/**
 * Resolve the configured model port, or undefined when none is selected.
 *
 * The injected `env` is handed to the adapter, so a composition that supplies
 * its own environment — rather than mutating the process one — still decides
 * the opt-in. Three gates must all pass: a supported provider is named, the
 * adapter reports itself configured, and nothing about the credential is
 * returned to the caller.
 *
 * @param env - Environment mapping; defaults to the process environment.
 * @returns A configured port, or undefined to keep regex-only behaviour.
 */
export function resolve_model_port(env: Record<string, string | undefined>): ModelPort | undefined {
  const provider = env[LLM_PROVIDER_ENV]?.trim().toLowerCase() ?? "";
  if (provider === "" || provider === "none" || provider === "disabled") return undefined;
  if (!(SUPPORTED_LLM_PROVIDERS as readonly string[]).includes(provider)) return undefined;
  // The factory re-checks that the named provider actually has a credential and
  // refuses to substitute a different vendor, so an operator who asks for one
  // provider and forgets its key gets regex-only behaviour rather than a silent
  // round trip to another vendor.
  return build_model_from_env({ env });
}

/**
 * Describe the active model configuration for startup logging.
 *
 * Reports the provider and model id only. The API key is never read here, so
 * it cannot reach a log line.
 *
 * @param env - Environment mapping.
 * @returns Provider and model labels, or undefined when the model is off.
 */
export function describe_model_config(
  env: Record<string, string | undefined>,
): { provider: string; model: string } | undefined {
  const model = resolve_model_port(env);
  if (model === undefined) return undefined;
  return { provider: model.provider, model: describe_model_id(model) };
}

/**
 * Read a model id off an adapter that exposes one.
 *
 * The `model_id` method is adapter-specific rather than part of
 * {@link ModelPort}, because a caller that only needs a label should not be
 * forced to depend on one vendor's class shape.
 *
 * @param model - Resolved adapter.
 * @returns The model id when the adapter publishes one, else `unknown`.
 */
function describe_model_id(model: ModelPort): string {
  const candidate = model as { model_id?: () => string };
  return typeof candidate.model_id === "function" ? candidate.model_id() : "unknown";
}