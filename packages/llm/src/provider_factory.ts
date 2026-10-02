/**
 * Provider selection from environment.
 *
 * Selection is explicit, never inferred. A provider is only chosen when its own
 * credential is present, and an explicit `LLM_PROVIDER` that has no credential
 * resolves to `undefined` rather than falling through to a different vendor —
 * silently answering from another provider would make the data-flow audit a
 * lie.
 */

import { AnthropicModel } from "./anthropic_model.js";
import { GeminiModel } from "./gemini_model.js";
import { OpenAiModel } from "./openai_model.js";
import type { EnvLike, FetchLike } from "./http_adapters.js";
import type { ModelPort } from "./port.js";

/** Providers this package can construct. */
export const SUPPORTED_PROVIDERS = ["anthropic", "gemini", "openai"] as const;

/** One selectable provider id. */
export type ProviderId = (typeof SUPPORTED_PROVIDERS)[number];

/** Environment variable naming the desired provider. */
export const LLM_PROVIDER_ENV = "LLM_PROVIDER";

/** Options shared by the provider factory. */
export interface ProviderFactoryOptions {
  /** Environment to read; injected so tests never touch real credentials. */
  env?: EnvLike;
  /** Transport seam; injected by tests to avoid network access. */
  fetch?: FetchLike;
  /** Override the model id regardless of the provider's own variable. */
  model?: string;
}

/**
 * Build the configured model adapter, if any.
 *
 * Resolution order: an explicit `LLM_PROVIDER` wins when that provider has a
 * credential; otherwise the first provider with a credential is used. The
 * chosen adapter is still returned only when `is_configured()` is true, so the
 * caller keeps the pre-LLM behaviour when nothing is wired up.
 *
 * @param options - Environment, transport, and optional model override.
 * @returns A configured adapter, or undefined to keep regex-only behaviour.
 */
export function build_model_from_env(options: ProviderFactoryOptions = {}): ModelPort | undefined {
  const env = options.env ?? {};
  const requested = normalize_provider(env[LLM_PROVIDER_ENV]);
  const adapter_options = {
    env,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.model === undefined ? {} : { model: options.model }),
  };
  if (requested !== undefined) {
    const selected = construct(requested, adapter_options);
    return selected.is_configured() ? selected : undefined;
  }
  for (const provider of SUPPORTED_PROVIDERS) {
    const candidate = construct(provider, adapter_options);
    if (candidate.is_configured()) return candidate;
  }
  return undefined;
}

/**
 * Parse an operator-supplied provider name.
 *
 * @param value - Raw environment value.
 * @returns The canonical id, or undefined when absent or unrecognised.
 */
export function normalize_provider(value: string | undefined): ProviderId | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  return (SUPPORTED_PROVIDERS as readonly string[]).includes(normalized)
    ? (normalized as ProviderId)
    : undefined;
}

function construct(
  provider: ProviderId,
  options: { env: EnvLike; fetch?: FetchLike; model?: string },
): ModelPort {
  if (provider === "anthropic") return new AnthropicModel(options);
  if (provider === "gemini") return new GeminiModel(options);
  return new OpenAiModel(options);
}