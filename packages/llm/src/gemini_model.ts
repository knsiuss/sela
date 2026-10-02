/**
 * Google Gemini adapter for the model port.
 *
 * API shape verified against Google's published `generateContent` REST
 * reference: `POST .../models/{model}:generateContent`, credential in the
 * `x-goog-api-key` header, request `{contents:[{parts:[{text}]}]}`, response
 * `{candidates:[{content:{parts:[{text}]}}]}` with
 * `usageMetadata.{promptTokenCount,candidatesTokenCount}`.
 */

import {
  backoff_ms,
  CLASSIFIER_SYSTEM_PROMPT,
  is_retryable,
  join_text_parts,
  read_credential,
  read_token_usage,
  trim_base_url,
  type EnvLike,
  type FetchLike,
} from "./http_adapters.js";
import {
  build_model_request,
  ModelPortError,
  type ModelAdapterOptions,
  type ModelPort,
  type ModelRequest,
  type ModelResponse,
} from "./port.js";

/** Generative Language API root; overridable for a proxy or local fake. */
const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";

/** API surface used for this call. */
const API_VERSION = "v1beta";

/** Environment variable holding the Gemini credential. */
export const GEMINI_API_KEY_ENV = "GEMINI_API_KEY";

/** Environment variable overriding the model id. */
export const GEMINI_MODEL_ENV = "GEMINI_MODEL";

/** Default model for short classification calls. */
export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash-lite";

/** Options for one Gemini adapter. */
export interface GeminiModelOptions extends ModelAdapterOptions {
  base_url?: string;
  model?: string;
  fetch?: FetchLike;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Environment the credential and model id are read from. Injected by default
   * to the process environment; tests pass an explicit mapping so a real
   * operator credential can never be picked up.
   */
  env?: EnvLike;
}

/**
 * Gemini-backed {@link ModelPort}.
 *
 * @example
 * ```ts
 * const model = new GeminiModel({ env: { GEMINI_API_KEY: key } });
 * if (!model.is_configured()) return regex_only_behaviour;
 * ```
 */
export class GeminiModel implements ModelPort {
  readonly provider = "gemini";

  private readonly env: EnvLike;
  private readonly fetch_impl: FetchLike;
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly metrics: ModelAdapterOptions["metrics"];
  private readonly timeout_ms: number | undefined;
  private readonly max_attempts: number;
  private readonly base_url: string;
  private readonly model: string;

  /**
   * @param options - Transport seams, bounds, and the environment to read.
   */
  constructor(options: GeminiModelOptions = {}) {
    this.env = options.env ?? {};
    this.fetch_impl = options.fetch ?? ((input, init) => fetch(input, init));
    this.clock = options.clock ?? Date.now;
    this.sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.metrics = options.metrics;
    this.timeout_ms = options.timeout_ms;
    this.max_attempts = options.max_attempts ?? 3;
    this.base_url = trim_base_url(options.base_url ?? DEFAULT_BASE_URL);
    this.model = options.model ?? this.env[GEMINI_MODEL_ENV] ?? DEFAULT_GEMINI_MODEL;
  }

  /**
   * @returns True only when `GEMINI_API_KEY` is a non-empty value.
   */
  is_configured(): boolean {
    return read_credential(this.env, GEMINI_API_KEY_ENV) !== undefined;
  }

  /**
   * @returns The configured model id; safe to log, unlike the credential.
   */
  model_id(): string {
    return this.model;
  }

  /**
   * Run one bounded `generateContent` call with a capped retry budget.
   *
   * SECURITY: the request is rebuilt through `build_model_request` before any
   * network call, so PII scrubbing happens at the boundary that performs I/O.
   * The API key travels in a header rather than a query string, because a URL
   * is far more likely to be captured in a proxy log or an error string.
   *
   * @param request - Candidate request; revalidated and redacted here.
   * @returns Candidate text plus provider token accounting.
   * @throws ModelPortError When unconfigured, timed out, or rejected.
   */
  async complete(request: ModelRequest): Promise<ModelResponse> {
    const api_key = read_credential(this.env, GEMINI_API_KEY_ENV);
    if (api_key === undefined) {
      throw new ModelPortError("not_configured", "gemini-api-key-missing");
    }
    const validated = build_model_request(request);
    let last_error: ModelPortError | undefined;
    for (let attempt = 1; attempt <= this.max_attempts; attempt += 1) {
      try {
        return await this.attempt(api_key, validated);
      } catch (error) {
        if (!(error instanceof ModelPortError) || !is_retryable(error)) throw error;
        last_error = error;
        if (attempt < this.max_attempts) await this.sleep(backoff_ms(attempt));
      }
    }
    throw last_error ?? new ModelPortError("provider_error", "gemini-request-failed");
  }

  private async attempt(api_key: string, request: ModelRequest): Promise<ModelResponse> {
    const started_ms = this.clock();
    try {
      const response = await this.send(api_key, request);
      // Status is checked before the body is read: parsing an error payload as
      // a success shape would turn a retryable 429 into a terminal parse failure.
      if (!response.ok) {
        throw new ModelPortError("provider_error", "gemini-status-error", response.status);
      }
      const parsed = this.parse(await response.json());
      this.metrics?.increment("llm_model_requests_total", { provider: this.provider, result: "ok" });
      this.metrics?.observe("llm_model_latency_ms", this.clock() - started_ms, { provider: this.provider });
      return parsed;
    } catch (error) {
      const failure = error instanceof ModelPortError
        ? error
        : new ModelPortError("provider_error", "gemini-request-failed");
      this.metrics?.increment("llm_model_requests_total", { provider: this.provider, result: failure.code });
      throw failure;
    }
  }

  private async send(api_key: string, request: ModelRequest): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeout_ms ?? this.timeout_ms ?? 2_000);
    try {
      return await this.fetch_impl(
        `${this.base_url}/${API_VERSION}/models/${encodeURIComponent(this.model)}:generateContent`,
        {
          method: "POST",
          headers: {
            "x-goog-api-key": api_key,
            "content-type": "application/json",
          },
          body: JSON.stringify(build_generate_content_body(request)),
          signal: controller.signal,
        },
      );
    } catch {
      if (controller.signal.aborted) throw new ModelPortError("timeout", "gemini-request-timeout");
      // The thrown value is discarded on purpose: a provider error can echo the
      // prompt back, and a transport error can carry the request headers.
      throw new ModelPortError("provider_error", "gemini-request-failed");
    } finally {
      clearTimeout(timer);
    }
  }

  private parse(payload: unknown): ModelResponse {
    if (typeof payload !== "object" || payload === null) {
      throw new ModelPortError("invalid_response", "gemini-response-not-json");
    }
    const root = payload as {
      candidates?: unknown;
      modelVersion?: unknown;
      usageMetadata?: unknown;
    };
    if (!Array.isArray(root.candidates) || root.candidates.length === 0) {
      throw new ModelPortError("invalid_response", "gemini-response-shape-invalid");
    }
    const first = root.candidates[0];
    if (typeof first !== "object" || first === null) {
      throw new ModelPortError("invalid_response", "gemini-response-shape-invalid");
    }
    const text = join_text_parts((first as { content?: unknown }).content === undefined
      ? undefined
      : (first as { content: { parts?: unknown } }).content?.parts);
    if (text === undefined) throw new ModelPortError("invalid_response", "gemini-response-shape-invalid");
    return {
      text,
      provider: this.provider,
      model: typeof root.modelVersion === "string" ? root.modelVersion : this.model,
      ...read_token_usage(root.usageMetadata, ["promptTokenCount", "candidatesTokenCount"]),
    };
  }
}

/**
 * Build the `generateContent` body.
 *
 * The classifier instruction is carried as a user-role prefix rather than a
 * `systemInstruction` field so the model sees one contiguous text block; this
 * keeps the redacted customer text adjacent to the rules that govern it.
 *
 * @param request - Validated and redacted request.
 * @returns JSON body for the provider.
 */
function build_generate_content_body(request: ModelRequest): Record<string, unknown> {
  const user_text = request.context === undefined
    ? request.user_text
    : `${request.context}\n\n${request.user_text}`;
  return {
    contents: [{ role: "user", parts: [{ text: `${CLASSIFIER_SYSTEM_PROMPT}\n\n${user_text}` }] }],
    generationConfig: { maxOutputTokens: request.max_output_tokens },
  };
}