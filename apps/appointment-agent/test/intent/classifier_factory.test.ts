/**
 * Tests for provider selection at the composition root.
 *
 * The invariant under test is opt-in: no credential means no model, and a named
 * provider without its own key never silently becomes a different vendor.
 */

import { describe, expect, it } from "vitest";
import {
  LLM_PROVIDER_ENV,
  SUPPORTED_LLM_PROVIDERS,
  describe_model_config,
  resolve_model_port,
} from "../../src/intent/classifier_factory.js";

describe("supported providers", () => {
  it("advertises all three adapters", () => {
    expect([...SUPPORTED_LLM_PROVIDERS].sort()).toEqual(["anthropic", "gemini", "openai"]);
  });
});

describe("model opt-in", () => {
  it("resolves nothing with no provider named", () => {
    expect(resolve_model_port({ ANTHROPIC_API_KEY: "secret" })).toBeUndefined();
  });

  it("resolves nothing for the explicit disabled values", () => {
    for (const value of ["", "none", "disabled", "NONE", " Disabled "]) {
      expect(resolve_model_port({ [LLM_PROVIDER_ENV]: value, ANTHROPIC_API_KEY: "secret" })).toBeUndefined();
    }
  });

  it("resolves nothing for an unimplemented provider", () => {
    expect(resolve_model_port({ [LLM_PROVIDER_ENV]: "skynet", ANTHROPIC_API_KEY: "secret" })).toBeUndefined();
  });

  it("resolves nothing when the named provider has no credential", () => {
    expect(resolve_model_port({ [LLM_PROVIDER_ENV]: "gemini" })).toBeUndefined();
  });
});

describe("provider resolution", () => {
  it("builds an anthropic adapter when its key is present", () => {
    expect(resolve_model_port({ [LLM_PROVIDER_ENV]: "anthropic", ANTHROPIC_API_KEY: "secret" })?.provider)
      .toBe("anthropic");
  });

  it("builds a gemini adapter when its key is present", () => {
    expect(resolve_model_port({ [LLM_PROVIDER_ENV]: "gemini", GEMINI_API_KEY: "secret" })?.provider)
      .toBe("gemini");
  });

  it("builds an openai adapter when its key is present", () => {
    expect(resolve_model_port({ [LLM_PROVIDER_ENV]: "openai", OPENAI_API_KEY: "secret" })?.provider)
      .toBe("openai");
  });

  it("is tolerant of case and surrounding whitespace", () => {
    expect(resolve_model_port({ [LLM_PROVIDER_ENV]: " OpenAI ", OPENAI_API_KEY: "secret" })?.provider)
      .toBe("openai");
  });

  it("refuses to substitute a different vendor when the named key is missing", () => {
    // OPENAI is configured but gemini was requested: answering from OpenAI
    // would make the data-flow audit wrong, so this must stay undefined.
    expect(resolve_model_port({ [LLM_PROVIDER_ENV]: "gemini", OPENAI_API_KEY: "secret" })).toBeUndefined();
  });
});

describe("startup description", () => {
  it("reports nothing when the model is off", () => {
    expect(describe_model_config({})).toBeUndefined();
  });

  it("reports provider and model id without touching the credential", () => {
    const described = describe_model_config({ [LLM_PROVIDER_ENV]: "gemini", GEMINI_API_KEY: "secret" });
    expect(described?.provider).toBe("gemini");
    expect(described?.model).toContain("gemini");
    expect(JSON.stringify(described)).not.toContain("secret");
  });

  it("honours a model id override in the description", () => {
    const described = describe_model_config({
      [LLM_PROVIDER_ENV]: "openai",
      OPENAI_API_KEY: "secret",
      OPENAI_MODEL: "gpt-5-mini",
    });
    expect(described?.model).toBe("gpt-5-mini");
  });
});