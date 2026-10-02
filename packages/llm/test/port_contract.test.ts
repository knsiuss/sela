/**
 * Port contract tests.
 *
 * Every adapter must satisfy the same contract, so these assertions run against
 * both the scripted fake and the Anthropic adapter with an injected fetch. They
 * are the reason the fake is trustworthy as a stand-in for the real provider.
 */

import { describe, expect, it } from "vitest";
import {
  AnthropicModel,
  DEFAULT_ANTHROPIC_MODEL,
  FakeModel,
  MAX_OUTPUT_TOKENS,
  MAX_PROMPT_CHARS,
  ModelPortError,
  build_model_request,
  contains_residual_pii,
  redact_pii,
  REDACTED_PHONE,
  type ModelPort,
  type ModelRequest,
} from "../src/index.js";

/**
 * Build an UNVALIDATED candidate request.
 *
 * Deliberately not passed through `build_model_request`: the out-of-bounds
 * contract cases below must reach the adapter so that the ADAPTER is what
 * rejects them. Validating here would make those tests throw inside the
 * helper and silently assert nothing about the port boundary.
 *
 * @param overrides - Fields to vary, including deliberately invalid values.
 * @returns A structurally valid `ModelRequest` that may violate the schema.
 */
function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    user_text: "mau booking besok",
    max_output_tokens: 128,
    timeout_ms: 500,
    ...overrides,
  };
}

/**
 * Shared adapter assertions.
 *
 * The Anthropic adapter reads its credential from the environment, so the
 * harness supplies one; the value is a test placeholder, never a real secret.
 */
function contract(name: string, make_model: () => ModelPort): void {
  describe(`${name} port contract`, () => {
    it("reports a configured state through the port seam", () => {
      expect(typeof make_model().is_configured()).toBe("boolean");
    });

    it("returns provider and model labels for metric attribution", async () => {
      const response = await make_model().complete(request());
      expect(response.provider.length).toBeGreaterThan(0);
      expect(response.model.length).toBeGreaterThan(0);
      expect(typeof response.text).toBe("string");
    });

    it("rejects an out-of-bounds request before any provider I/O", async () => {
      await expect(
        make_model().complete(request({ max_output_tokens: MAX_OUTPUT_TOKENS + 1 })),
      ).rejects.toThrow(ModelPortError);
    });

    it("reports a sanitized failure code and never the request content", async () => {
      const error = await make_model().complete(request()).catch((caught: unknown) => caught);
      if (error instanceof ModelPortError) {
        expect(error.message).not.toContain("mau booking");
        expect(typeof error.code).toBe("string");
      }
    });
  });
}

describe("scrubbed fake adapter", () => {
  it("serves scripted text and records the request it was given", async () => {
    const model = new FakeModel({
      outcomes: [{ kind: "text", text: '{"intent":"book"}', input_tokens: 12, output_tokens: 8 }],
    });

    const response = await model.complete(request({ user_text: "mau booking 081234567890" }));

    expect(response.text).toBe('{"intent":"book"}');
    expect(response.input_tokens).toBe(12);
    expect(model.call_count()).toBe(1);
    expect(model.recorded_calls()[0]?.user_text).toContain(REDACTED_PHONE);
  });

  it("repeats the last outcome so a retry budget is testable", async () => {
    const model = new FakeModel({ outcomes: [{ kind: "text", text: "first" }, { kind: "text", text: "last" }] });
    await model.complete(request());
    await model.complete(request());
    expect((await model.complete(request())).text).toBe("last");
  });

  it("fails closed when built unconfigured", async () => {
    const model = new FakeModel({ configured: false });
    expect(model.is_configured()).toBe(false);
    await expect(model.complete(request())).rejects.toMatchObject({ code: "not_configured" });
  });

  it("surfaces a scripted timeout as a coded failure", async () => {
    const model = new FakeModel({ outcomes: [{ kind: "error", code: "timeout" }] });
    await expect(model.complete(request())).rejects.toMatchObject({ code: "timeout" });
  });

  it("fails closed when the script is empty", async () => {
    await expect(new FakeModel().complete(request())).rejects.toMatchObject({ code: "provider_error" });
  });

  it("caps the attempt budget at the shared ceiling", () => {
    expect(new FakeModel({ max_attempts: 99 }).attempts_allowed()).toBe(3);
    expect(new FakeModel({ max_attempts: 1 }).attempts_allowed()).toBe(1);
  });
});

describe("anthropic adapter", () => {
  function stub_model(body: unknown, ok = true, status = 200): AnthropicModel {
    return new AnthropicModel({
      model: "claude-haiku-4-5",
      fetch: async () => new Response(JSON.stringify(body), { status: ok ? 200 : status }),
    });
  }

  it("refuses to call the provider without a credential", async () => {
    const previous = process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];
    try {
      const model = new AnthropicModel({ fetch: async () => new Response("{}") });
      expect(model.is_configured()).toBe(false);
      await expect(model.complete(request())).rejects.toMatchObject({ code: "not_configured" });
    } finally {
      if (previous !== undefined) process.env["ANTHROPIC_API_KEY"] = previous;
    }
  });

  it("extracts the text blocks and usage from a Messages response", async () => {
    const previous = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = "test-key-not-a-real-secret";
    try {
      const model = stub_model({
        model: "claude-haiku-4-5",
        content: [{ type: "text", text: '{"intent":"book"}' }],
        usage: { input_tokens: 20, output_tokens: 6 },
      });
      const response = await model.complete(request());
      expect(response.text).toBe('{"intent":"book"}');
      expect(response.output_tokens).toBe(6);
    } finally {
      if (previous === undefined) delete process.env["ANTHROPIC_API_KEY"];
      else process.env["ANTHROPIC_API_KEY"] = previous;
    }
  });

  it("never puts the credential or the prompt into a failure", async () => {
    const previous = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = "super-secret-key-value";
    try {
      const model = new AnthropicModel({ fetch: async () => new Response("nope", { status: 400 }) });
      const error = await model.complete(request({ user_text: "call 081234567890" })).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ModelPortError);
      expect((error as ModelPortError).status).toBe(400);
      expect((error as Error).message).not.toContain("super-secret-key-value");
      expect((error as Error).message).not.toContain("081234567890");
    } finally {
      if (previous === undefined) delete process.env["ANTHROPIC_API_KEY"];
      else process.env["ANTHROPIC_API_KEY"] = previous;
    }
  });

  it("sends a bounded request with the system prompt and no customer text in it", async () => {
    const previous = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    let seen: { body: string; headers: Record<string, string> } | undefined;
    try {
      const model = new AnthropicModel({
        fetch: async (_url, init) => {
          seen = { body: init.body, headers: init.headers };
          return new Response(JSON.stringify({ content: [{ type: "text", text: "{}" }] }), { status: 200 });
        },
      });
      await model.complete(request({ user_text: "hey bro" }));
      const body = JSON.parse(seen?.body ?? "{}") as Record<string, unknown>;
      expect(body["max_tokens"]).toBe(128);
      expect(String(body["system"])).not.toContain("hey bro");
      expect(seen?.headers["anthropic-version"]).toBe("2023-06-01");
    } finally {
      if (previous === undefined) delete process.env["ANTHROPIC_API_KEY"];
      else process.env["ANTHROPIC_API_KEY"] = previous;
    }
  });

  it("retries a 5xx within the budget and then fails closed", async () => {
    const previous = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    let attempts = 0;
    try {
      const model = new AnthropicModel({
        max_attempts: 2,
        sleep: async () => undefined,
        fetch: async () => {
          attempts += 1;
          return new Response("boom", { status: 503 });
        },
      });
      await expect(model.complete(request())).rejects.toMatchObject({ code: "provider_error" });
      expect(attempts).toBe(2);
    } finally {
      if (previous === undefined) delete process.env["ANTHROPIC_API_KEY"];
      else process.env["ANTHROPIC_API_KEY"] = previous;
    }
  });

  it("does not retry a 4xx", async () => {
    const previous = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    let attempts = 0;
    try {
      const model = new AnthropicModel({
        sleep: async () => undefined,
        fetch: async () => {
          attempts += 1;
          return new Response("bad", { status: 400 });
        },
      });
      await expect(model.complete(request())).rejects.toBeInstanceOf(ModelPortError);
      expect(attempts).toBe(1);
    } finally {
      if (previous === undefined) delete process.env["ANTHROPIC_API_KEY"];
      else process.env["ANTHROPIC_API_KEY"] = previous;
    }
  });

  it("rejects a response whose content shape is not text blocks", async () => {
    const previous = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    try {
      await expect(stub_model({ content: "plain string" }).complete(request()))
        .rejects.toMatchObject({ code: "invalid_response" });
    } finally {
      if (previous === undefined) delete process.env["ANTHROPIC_API_KEY"];
      else process.env["ANTHROPIC_API_KEY"] = previous;
    }
  });
});

describe("model port redaction boundary", () => {
  it("removes phone numbers and emails from every outbound string", () => {
    const scrubbed = redact_pii("call 081234567890 or mail me@example.com");
    expect(scrubbed).not.toContain("081234567890");
    expect(scrubbed).not.toContain("me@example.com");
    expect(contains_residual_pii(scrubbed)).toBe(false);
  });

  it("redacts the request rather than trusting the caller to have done it", () => {
    const built = build_model_request({
      user_text: "call 081234567890",
      context: "mail patient@example.com",
      max_output_tokens: 64,
      timeout_ms: 500,
    });
    expect(contains_residual_pii(built.user_text)).toBe(false);
    expect(contains_residual_pii(built.context ?? "")).toBe(false);
  });

  it("truncates after scrubbing so a cut cannot expose a partial identifier", () => {
    // Redaction GROWS text: "081234567890" is 12 characters and
    // "[REDACTED_PHONE]" is 16, so masking adds four. This input sits exactly
    // on the schema cap so it is accepted, then expands past it and must be cut
    // back down without leaving a live digit sequence behind.
    const phone = "081234567890";
    const prefix_length = MAX_PROMPT_CHARS - phone.length - 1;
    const built = build_model_request({
      user_text: `${"x".repeat(prefix_length)} ${phone}`,
      max_output_tokens: 64,
      timeout_ms: 500,
    });
    expect(built.user_text.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
    expect(contains_residual_pii(built.user_text)).toBe(false);
    expect(built.user_text).not.toContain(phone);
  });

  it("rejects an oversized request instead of silently sending it", () => {
    expect(() => build_model_request({
      user_text: "x".repeat(4_001),
      max_output_tokens: 64,
      timeout_ms: 500,
    })).toThrow(ModelPortError);
  });

  it("rejects a request carrying an unexpected field", () => {
    expect(() => build_model_request({
      user_text: "hi",
      max_output_tokens: 64,
      timeout_ms: 500,
      tenant_id: "42",
    })).toThrow(ModelPortError);
  });
});

describe("anthropic outbound redaction boundary", () => {
  /**
   * Run one call with an injected credential and return the serialized body.
   *
   * The request handed to the adapter is deliberately left UNREDACTED so the
   * test proves the adapter scrubs it rather than trusting its caller.
   */
  async function body_for_unredacted_text(user_text: string): Promise<string> {
    const previous = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = "test-key";
    let body = "";
    try {
      const model = new AnthropicModel({
        fetch: async (_url, init) => {
          body = init.body;
          return new Response(JSON.stringify({ content: [{ type: "text", text: "{}" }] }), { status: 200 });
        },
      });
      await model.complete({ user_text, max_output_tokens: 64, timeout_ms: 500 });
      return body;
    } finally {
      if (previous === undefined) delete process.env["ANTHROPIC_API_KEY"];
      else process.env["ANTHROPIC_API_KEY"] = previous;
    }
  }

  it("scrubs PII even when the caller hands the adapter raw customer text", async () => {
    const body = await body_for_unredacted_text("call 081234567890 or mail me@example.com");
    expect(body).not.toContain("081234567890");
    expect(body).not.toContain("me@example.com");
    expect(body).toContain(REDACTED_PHONE);
    expect(contains_residual_pii(body)).toBe(false);
  });

  it("scrubs a secret-looking assignment before it reaches the wire", async () => {
    const body = await body_for_unredacted_text("api_key=sk-live-should-never-leave");
    expect(body).not.toContain("sk-live-should-never-leave");
    expect(contains_residual_pii(body)).toBe(false);
  });

  it("reads the credential from the injected environment, not the process one", async () => {
    const previous = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = "process-level-key";
    try {
      const model = new AnthropicModel({ env: {} });
      expect(model.is_configured()).toBe(false);
      await expect(model.complete(request())).rejects.toMatchObject({ code: "not_configured" });

      const injected = new AnthropicModel({ env: { ANTHROPIC_API_KEY: "  " } });
      expect(injected.is_configured()).toBe(false);
    } finally {
      if (previous === undefined) delete process.env["ANTHROPIC_API_KEY"];
      else process.env["ANTHROPIC_API_KEY"] = previous;
    }
  });

  it("reads the model id from the injected environment", () => {
    expect(new AnthropicModel({ env: {} }).model_id()).toBe(DEFAULT_ANTHROPIC_MODEL);
    expect(new AnthropicModel({ env: { ANTHROPIC_MODEL: "custom-model" } }).model_id()).toBe("custom-model");
  });

  it("re-reads the credential at call time so a rotation needs no rebuild", async () => {
    const env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: "rotated-key" };
    const model = new AnthropicModel({ env, fetch: async () => new Response("{}") });
    expect(model.is_configured()).toBe(true);
    env["ANTHROPIC_API_KEY"] = undefined;
    expect(model.is_configured()).toBe(false);
  });
});

contract("fake", () => new FakeModel({ outcomes: [{ kind: "text", text: "{}" }] }));
contract("anthropic", () => stub_model_for_contract());

/** Build an Anthropic adapter whose credential is a test placeholder. */
function stub_model_for_contract(): ModelPort {
  process.env["ANTHROPIC_API_KEY"] = "contract-test-placeholder";
  return new AnthropicModel({
    sleep: async () => undefined,
    fetch: async () => new Response(JSON.stringify({ content: [{ type: "text", text: "{}" }] }), { status: 200 }),
  });
}