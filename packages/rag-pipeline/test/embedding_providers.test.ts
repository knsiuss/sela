/** Unit tests for deterministic and external embedding providers. */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EmbeddingProviderError,
  FakeEmbedding,
  OpenAIEmbedding,
} from "../src/embedding_providers.js";

const TEST_API_KEY = "unit-test-credential";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.OPENAI_API_KEY;
});

describe("FakeEmbedding", () => {
  it("returns deterministic normalized vectors with the requested width", async () => {
    const provider = new FakeEmbedding(32);
    const first = await provider.embed(["tenant policy"]);
    const second = await provider.embed(["tenant policy"]);

    expect(first[0]).toHaveLength(32);
    expect(first[0]).toEqual(second[0]);
    const norm = Math.sqrt(
      (first[0] ?? []).reduce((sum, value) => sum + value * value, 0),
    );
    expect(norm).toBeCloseTo(1);
  });

  it("rejects invalid dimensions", () => {
    expect(() => new FakeEmbedding(0)).toThrow(EmbeddingProviderError);
  });

  it("rejects empty input text", async () => {
    await expect(new FakeEmbedding(8).embed([" "])).rejects.toMatchObject({
      code: "invalid_input",
    });
  });
});

describe("OpenAIEmbedding", () => {
  it("reads the API key at call time and defaults to 1536 dimensions", async () => {
    const provider = new OpenAIEmbedding();
    const fetch_mock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ data: [{ embedding: new Array(1536).fill(0.1) }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetch_mock);
    process.env.OPENAI_API_KEY = TEST_API_KEY;

    const vectors = await provider.embed(["tenant policy"]);

    expect(provider.dimensions).toBe(1536);
    expect(vectors[0]).toHaveLength(1536);
    expect(fetch_mock).toHaveBeenCalledOnce();
    expect(fetch_mock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("fails closed when the API key is not configured", async () => {
    const provider = new OpenAIEmbedding();
    const fetch_mock = vi.fn();
    vi.stubGlobal("fetch", fetch_mock);

    await expect(provider.embed(["tenant policy"])).rejects.toMatchObject({
      code: "missing_api_key",
    });
    expect(fetch_mock).not.toHaveBeenCalled();
  });

  it("translates network failures without returning provider internals", async () => {
    process.env.OPENAI_API_KEY = TEST_API_KEY;
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network detail")));

    await expect(new OpenAIEmbedding().embed(["tenant policy"])).rejects.toMatchObject({
      code: "request_failed",
    });
  });

  it("translates provider HTTP failures without exposing the response body", async () => {
    process.env.OPENAI_API_KEY = TEST_API_KEY;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("provider detail", { status: 503 })),
    );

    await expect(new OpenAIEmbedding().embed(["tenant policy"])).rejects.toMatchObject({
      code: "request_failed",
      status_code: 503,
    });
  });

  it("rejects malformed JSON responses", async () => {
    process.env.OPENAI_API_KEY = TEST_API_KEY;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("not-json", { status: 200 })),
    );

    await expect(new OpenAIEmbedding().embed(["tenant policy"])).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("rejects response counts that do not match the input batch", async () => {
    process.env.OPENAI_API_KEY = TEST_API_KEY;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(new OpenAIEmbedding().embed(["tenant policy"])).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("rejects response vectors with the wrong dimensions", async () => {
    process.env.OPENAI_API_KEY = TEST_API_KEY;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(new OpenAIEmbedding().embed(["tenant policy"])).rejects.toMatchObject({
      code: "invalid_response",
    });
  });
});
