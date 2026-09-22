export interface EmbeddingProvider {
  dimensions: number;
  model: string;
  version: string;
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * Deterministic fake embeddings for offline tests.
 *
 * Hashes text into a fixed vector. Captures shape (dimensions, unit-ish
 * scale) without any semantic meaning. Never use for retrieval quality.
 */
export class FakeEmbedding implements EmbeddingProvider {
  readonly dimensions: number;
  readonly model = "fake-hash-v1";
  readonly version = "test-only";

  constructor(dimensions = 64) {
    this.dimensions = dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const vector = new Array<number>(this.dimensions).fill(0);
      for (let i = 0; i < text.length; i++) {
        vector[i % this.dimensions] += text.charCodeAt(i) / 255;
      }
      const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
      return vector.map((value) => value / norm);
    });
  }
}

/**
 * OpenAI embeddings via REST. Key from env at call time, never logged.
 * Swap for BGE-M3 self-host by implementing EmbeddingProvider.
 */
export class OpenAIEmbedding implements EmbeddingProvider {
  readonly dimensions: number;
  readonly model: string;
  readonly version: string;

  constructor(model = "text-embedding-3-small", dimensions = 1536) {
    this.model = model;
    this.dimensions = dimensions;
    this.version = `${model}@${dimensions}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const api_key = process.env.OPENAI_API_KEY;
    if (!api_key) throw new Error("missing OPENAI_API_KEY");
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${api_key}` },
      body: JSON.stringify({ model: this.model, dimensions: this.dimensions, input: texts }),
    });
    if (!response.ok) throw new Error(`embedding-request-failed: ${response.status}`);
    const payload = (await response.json()) as { data: { embedding: number[] }[] };
    return payload.data.map((item) => item.embedding);
  }
}
