/** Embedding providers with explicit dimensions and call-time API credentials. */
import { z } from "zod";
import {
  DEFAULT_EMBEDDING_DIMENSIONS,
  DEFAULT_EMBEDDING_MODEL,
} from "./rag_types.js";

const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
const OPENAI_REQUEST_TIMEOUT_MS = 30_000;
const embedding_response_schema = z.object({
  data: z.array(z.object({ embedding: z.array(z.number()) })),
});

/** Stable failure categories safe to translate at an API boundary. */
export type EmbeddingProviderErrorCode =
  | "invalid_input"
  | "missing_api_key"
  | "request_failed"
  | "invalid_response";

/** Raised without request headers, API keys, or provider response bodies. */
export class EmbeddingProviderError extends Error {
  readonly code: EmbeddingProviderErrorCode;
  readonly status_code: number | undefined;

  constructor(code: EmbeddingProviderErrorCode, message: string, status_code?: number) {
    super(message);
    this.name = "EmbeddingProviderError";
    this.code = code;
    this.status_code = status_code;
  }
}

/** Versioned provider contract consumed by ingestion code. */
export interface EmbeddingProvider {
  dimensions: number;
  model: string;
  version: string;
  embed(texts: string[]): Promise<number[][]>;
}

function validate_dimensions(dimensions: number): void {
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new EmbeddingProviderError(
      "invalid_input",
      "embedding dimensions must be a positive integer",
    );
  }
}

function validate_texts(texts: string[]): void {
  if (texts.some((text) => text.trim() === "")) {
    throw new EmbeddingProviderError(
      "invalid_input",
      "embedding text must not be empty",
    );
  }
}

/**
 * Deterministic local provider for tests and offline development.
 *
 * Character-code buckets produce stable unit-length vectors without semantic
 * meaning. It must not be used to assess retrieval quality.
 */
export class FakeEmbedding implements EmbeddingProvider {
  readonly dimensions: number;
  readonly model = "fake-hash-v1";
  readonly version = "test-only";

  constructor(dimensions = 64) {
    validate_dimensions(dimensions);
    this.dimensions = dimensions;
  }

  /**
   * Embed a batch without network access.
   *
   * @param texts Non-empty strings; an empty batch returns an empty batch.
   * @returns One normalized vector per input, in the same order.
   * @throws EmbeddingProviderError when a text is empty.
   */
  async embed(texts: string[]): Promise<number[][]> {
    validate_texts(texts);
    return texts.map((text) => this.build_vector(text));
  }

  private build_vector(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    for (let index = 0; index < text.length; index += 1) {
      vector[index % this.dimensions] += text.charCodeAt(index) / 255;
    }
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
    return vector.map((value) => value / norm);
  }
}

/**
 * OpenAI embeddings provider using a 1536-dimension default.
 *
 * `OPENAI_API_KEY` is read for every batch so rotation takes effect without
 * rebuilding the provider. Credentials and response bodies are never logged.
 */
export class OpenAIEmbedding implements EmbeddingProvider {
  readonly dimensions: number;
  readonly model: string;
  readonly version: string;

  constructor(
    model = DEFAULT_EMBEDDING_MODEL,
    dimensions = DEFAULT_EMBEDDING_DIMENSIONS,
  ) {
    validate_dimensions(dimensions);
    this.model = model;
    this.dimensions = dimensions;
    this.version = `${model}@${dimensions}`;
  }

  /**
   * Request one OpenAI embedding per input text.
   *
   * @param texts Non-empty strings; an empty batch returns without I/O.
   * @returns Vectors matching the configured width and input order.
   * @throws EmbeddingProviderError on missing credentials, failed I/O, or an
   * invalid provider response.
   */
  async embed(texts: string[]): Promise<number[][]> {
    validate_texts(texts);
    if (texts.length === 0) {
      return [];
    }
    const api_key = process.env.OPENAI_API_KEY;
    if (api_key === undefined || api_key.trim() === "") {
      throw new EmbeddingProviderError(
        "missing_api_key",
        "OPENAI_API_KEY is not configured",
      );
    }
    const response = await this.request_embeddings(api_key, texts);
    if (!response.ok) {
      throw new EmbeddingProviderError(
        "request_failed",
        `embedding request failed with status ${response.status}`,
        response.status,
      );
    }
    return this.parse_response(response, texts.length);
  }

  private async request_embeddings(
    api_key: string,
    texts: string[],
  ): Promise<Response> {
    try {
      return await fetch(OPENAI_EMBEDDINGS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${api_key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          dimensions: this.dimensions,
          input: texts,
        }),
        signal: AbortSignal.timeout(OPENAI_REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new EmbeddingProviderError(
        "request_failed",
        "embedding request failed before a response was received",
      );
    }
  }

  private async parse_response(
    response: Response,
    expected_count: number,
  ): Promise<number[][]> {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new EmbeddingProviderError(
        "invalid_response",
        "embedding response was not JSON",
      );
    }
    const parsed = embedding_response_schema.safeParse(payload);
    if (!parsed.success || parsed.data.data.length !== expected_count) {
      throw new EmbeddingProviderError(
        "invalid_response",
        "embedding response count was invalid",
      );
    }
    const vectors = parsed.data.data.map((item) => item.embedding);
    if (vectors.some((vector) => vector.length !== this.dimensions)) {
      throw new EmbeddingProviderError(
        "invalid_response",
        "embedding response dimensions were invalid",
      );
    }
    return vectors;
  }
}
