/**
 * Deterministic in-memory model adapter for tests and offline development.
 *
 * The adapter holds scripted responses and records every request it served, so
 * a test can assert both what the model was asked and what the caller did with
 * the answer. It performs no network I/O and never produces a confidence the
 * caller did not script, which keeps it useless as a silent production path.
 */

import {
  bound_model_text,
  build_model_request,
  MAX_ATTEMPTS,
  MAX_OUTPUT_TOKENS,
  ModelPortError,
  resolve_max_attempts,
  type ModelAdapterOptions,
  type ModelPort,
  type ModelRequest,
  type ModelResponse,
} from "./port.js";

/** One recorded request, retained for assertions. */
export interface RecordedModelCall {
  user_text: string;
  context?: string;
  max_output_tokens: number;
}

/** Scripted response or scripted failure for one call. */
export type ScriptedOutcome =
  | { kind: "text"; text: string; input_tokens?: number; output_tokens?: number }
  | { kind: "error"; code: "timeout" | "provider_error" | "invalid_response"; status?: number };

/** Options for one scripted model. */
export interface FakeModelOptions extends ModelAdapterOptions {
  /** Provider label reported to metrics; defaults to `fake`. */
  provider?: string;
  /** Model label reported to metrics; defaults to `fake-scripted-v1`. */
  model?: string;
  /** When false, `is_configured` reports an unconfigured port. */
  configured?: boolean;
  /** Outcomes served in order; the last one repeats when exhausted. */
  outcomes?: ScriptedOutcome[];
  /** Optional fixed clock so recorded latency is deterministic. */
  clock?: () => number;
}

/**
 * Scripted adapter implementing {@link ModelPort}.
 *
 * @example
 * ```ts
 * const model = new FakeModel({ outcomes: [{ kind: "text", text: '{"intent":"book"}' }] });
 * const response = await model.complete(build_model_request({
 *   user_text: "mau booking",
 *   max_output_tokens: 64,
 *   timeout_ms: 500,
 * }));
 * ```
 */
export class FakeModel implements ModelPort {
  /** Provider identifier used as a metric label. */
  readonly provider: string;

  private readonly model: string;
  private readonly configured: boolean;
  private readonly outcomes: ScriptedOutcome[];
  private readonly clock: () => number;
  private readonly max_attempts: number;
  private readonly calls: RecordedModelCall[] = [];
  private index = 0;

  /**
   * Create a scripted model.
   *
   * @param options - Provider labels, scripted outcomes, and bounded limits.
   */
  constructor(options: FakeModelOptions = {}) {
    this.provider = options.provider ?? "fake";
    this.model = options.model ?? "fake-scripted-v1";
    this.configured = options.configured ?? true;
    this.outcomes = options.outcomes ?? [];
    this.clock = options.clock ?? Date.now;
    this.max_attempts = resolve_max_attempts(options.max_attempts);
  }

  /** True unless the adapter was explicitly built unconfigured. */
  is_configured(): boolean {
    return this.configured;
  }

  /**
   * Return the next scripted outcome without any I/O.
   *
   * @param request - Candidate request; validated so tests exercise the port contract.
   * @returns The scripted provider text with token accounting.
   * @throws ModelPortError When unconfigured or the script says to fail.
   */
  async complete(request: ModelRequest): Promise<ModelResponse> {
    const validated = build_model_request(request);
    if (!this.configured) {
      throw new ModelPortError("not_configured", "fake-model-not-configured");
    }
    this.calls.push(record_call(validated));
    const outcome = this.outcomes[Math.min(this.index, this.outcomes.length - 1)];
    this.index += 1;
    if (outcome === undefined) {
      throw new ModelPortError("provider_error", "fake-model-script-empty");
    }
    if (outcome.kind === "error") {
      throw new ModelPortError(outcome.code, `fake-model-${outcome.code}`, outcome.status);
    }
    return {
      text: bound_model_text(outcome.text),
      provider: this.provider,
      model: this.model,
      ...(outcome.input_tokens === undefined ? {} : { input_tokens: outcome.input_tokens }),
      ...(outcome.output_tokens === undefined ? {} : { output_tokens: outcome.output_tokens }),
    };
  }

  /** Requests served so far, in call order. */
  recorded_calls(): RecordedModelCall[] {
    return this.calls.map((call) => ({ ...call }));
  }

  /** Number of requests served; the routing test's primary assertion. */
  call_count(): number {
    return this.calls.length;
  }

  /** Attempts a caller is allowed before giving up. */
  attempts_allowed(): number {
    return Math.min(this.max_attempts, MAX_ATTEMPTS);
  }
}

function record_call(request: ModelRequest): RecordedModelCall {
  return {
    user_text: request.user_text,
    ...(request.context === undefined ? {} : { context: request.context }),
    max_output_tokens: Math.min(request.max_output_tokens, MAX_OUTPUT_TOKENS),
  };
}