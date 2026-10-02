/** Public API for the provider-agnostic model port and its adapters. */

export {
  ANTHROPIC_API_KEY_ENV,
  ANTHROPIC_MODEL_ENV,
  AnthropicModel,
  DEFAULT_ANTHROPIC_MODEL,
  type AnthropicModelOptions,
  type FetchLike,
} from "./anthropic_model.js";
export {
  DEFAULT_GEMINI_MODEL,
  GEMINI_API_KEY_ENV,
  GEMINI_MODEL_ENV,
  GeminiModel,
  type GeminiModelOptions,
} from "./gemini_model.js";
export {
  DEFAULT_OPENAI_MODEL,
  OPENAI_API_KEY_ENV,
  OPENAI_MODEL_ENV,
  OpenAiModel,
  type OpenAiModelOptions,
} from "./openai_model.js";
export {
  type EnvLike,
  read_credential,
} from "./http_adapters.js";
export {
  LLM_PROVIDER_ENV,
  SUPPORTED_PROVIDERS,
  build_model_from_env,
  normalize_provider,
  type ProviderFactoryOptions,
  type ProviderId,
} from "./provider_factory.js";
export {
  FakeModel,
  type FakeModelOptions,
  type RecordedModelCall,
  type ScriptedOutcome,
} from "./fake_model.js";
export {
  DEFAULT_TIMEOUT_MS,
  MAX_ATTEMPTS,
  MAX_OUTPUT_TOKENS,
  MAX_PROMPT_CHARS,
  ModelPortError,
  bound_model_text,
  build_model_request,
  model_request_schema,
  resolve_max_attempts,
  type ModelAdapterOptions,
  type ModelMetricsSink,
  type ModelPort,
  type ModelPortErrorCode,
  type ModelRequest,
  type ModelResponse,
} from "./port.js";
export {
  MAX_REDACTED_TEXT_CHARS,
  REDACTED_EMAIL,
  REDACTED_PHONE,
  REDACTED_SECRET,
  contains_residual_pii,
  redact_pii,
} from "./redaction.js";