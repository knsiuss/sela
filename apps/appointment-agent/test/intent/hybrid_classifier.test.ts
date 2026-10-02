/**
 * Hybrid intent routing tests.
 *
 * These assertions are the security contract of the model boundary: a
 * deterministic intent must never reach the provider, an ambiguous one must,
 * and every model failure mode must land on exactly the pre-LLM regex answer.
 * They also pin that the model can only ever PROPOSE an intent — it never
 * carries an identifier, and it never reaches the destructive or
 * confirmation-gated intents at all.
 */

import { describe, expect, it } from "vitest";
import { FakeModel, type ModelPort, type ScriptedOutcome } from "@repo/llm";
import { classify_intent } from "../../src/guardrails.js";
import {
  CLASSIFIER_MAX_OUTPUT_TOKENS,
  MAX_MODEL_CONFIDENCE,
  MODEL_ALLOWED_INTENTS,
  MODEL_FORBIDDEN_INTENTS,
  REGEX_LOW_CONFIDENCE,
  UNKNOWN_CONFIDENCE,
  bound_confidence,
  classify_intent_hybrid,
  is_allowed_intent,
  is_forbidden_intent,
  parse_model_proposal,
  type HybridClassifiedIntent,
} from "../../src/intent/hybrid_classifier.js";
import type { Intent } from "../../src/state.js";

/** Message the regex path cannot place, so the model must be consulted. */
const AMBIGUOUS_MESSAGE = "itu yang mana ya";

/** Recording metrics sink so label values can be asserted for PII. */
class RecordingMetrics {
  readonly calls: { name: string; labels: Record<string, string> }[] = [];

  increment(name: string, labels: Readonly<Record<string, string>> = {}): void {
    this.calls.push({ name, labels: { ...labels } });
  }
}

function scripted(outcome: ScriptedOutcome): FakeModel {
  return new FakeModel({ outcomes: [outcome] });
}

function proposing(intent: string, confidence = 0.9): FakeModel {
  return scripted({ kind: "text", text: JSON.stringify({ intent, confidence }) });
}

describe("regex fast path authority", () => {
  const deterministic: [string, Intent][] = [
    ["ya", "confirm"],
    ["batal", "cancel"],
    ["mau reschedule", "reschedule"],
    ["mau booking", "book"],
    ["hey bro", "greet"],
  ];

  for (const [message, expected] of deterministic) {
    it(`never consults the model for the deterministic intent ${expected}`, async () => {
      const model = proposing(expected);
      const result = await classify_intent_hybrid(message, { model });
      expect(model.call_count()).toBe(0);
      expect(result.intent).toBe(expected);
      expect(result.source).toBe("regex");
    });
  }

  it("treats a confident regex result as final even when it is unknown", async () => {
    const model = proposing("book");
    const result = await classify_intent_hybrid(AMBIGUOUS_MESSAGE, {
      model,
      regex_classifier: () => ({ intent: "unknown", confidence: REGEX_LOW_CONFIDENCE }),
    });
    expect(model.call_count()).toBe(0);
    expect(result).toMatchObject({ intent: "unknown", confidence: REGEX_LOW_CONFIDENCE, source: "regex" });
  });

  it("consults the model when regex is unsure", async () => {
    const model = proposing("book");
    const result = await classify_intent_hybrid(AMBIGUOUS_MESSAGE, { model });
    expect(model.call_count()).toBe(1);
    expect(result.intent).toBe("book");
    expect(result.source).toBe("model");
  });
});

describe("the model proposes, it never decides", () => {
  it("does not let the model produce the confirmation-gated intents", async () => {
    for (const forbidden of MODEL_FORBIDDEN_INTENTS) {
      const model = proposing(forbidden);
      const result = await classify_intent_hybrid(AMBIGUOUS_MESSAGE, { model });
      expect(result.intent).toBe("unknown");
      expect(result.source).toBe("regex");
      expect(result.fallback_reason).toBeDefined();
    }
  });

  it("rejects confirm_move outright, since it is a button action", () => {
    expect(is_forbidden_intent("confirm_move")).toBe(true);
    expect(is_forbidden_intent("confirm_move_g1")).toBe(true);
    expect(is_allowed_intent("confirm_move")).toBe(false);
  });

  it("keeps the allow-list disjoint from the deny-list", () => {
    for (const allowed of MODEL_ALLOWED_INTENTS) {
      expect(is_forbidden_intent(allowed)).toBe(false);
    }
  });

  it("never lets the model reach cancel, which the regex path owns", () => {
    expect(is_allowed_intent("cancel")).toBe(false);
    expect(is_allowed_intent("confirm")).toBe(false);
  });

  it("sends no identifier, tenant, or session field to the provider", async () => {
    const model = proposing("book");
    await classify_intent_hybrid(AMBIGUOUS_MESSAGE, { model });
    const call = model.recorded_calls()[0];
    expect(call).toBeDefined();
    // The port schema is `.strict()`, so any attempt to smuggle an
    // appointment_id, slot_id, tenant_id, hold_id, or expected_version would
    // be rejected as invalid_request rather than transmitted.
    expect(Object.keys(call ?? {}).sort()).toEqual(["max_output_tokens", "user_text"]);
    expect(call?.max_output_tokens).toBe(CLASSIFIER_MAX_OUTPUT_TOKENS);
  });

  it("redacts PII before the text leaves the process", async () => {
    const model = proposing("book");
    await classify_intent_hybrid(`${AMBIGUOUS_MESSAGE} 081234567890`, { model });
    expect(model.recorded_calls()[0]?.user_text).not.toContain("081234567890");
  });

  it("bounds the token budget so one turn cannot request an unbounded answer", () => {
    expect(CLASSIFIER_MAX_OUTPUT_TOKENS).toBeLessThanOrEqual(512);
  });
});

describe("fail-closed degradation matches pre-LLM behaviour", () => {
  async function degraded_with(model: ModelPort | undefined): Promise<HybridClassifiedIntent> {
    const result = await classify_intent_hybrid(AMBIGUOUS_MESSAGE, { ...(model === undefined ? {} : { model }) });
    expect(result.intent).toBe(classify_intent(AMBIGUOUS_MESSAGE).intent);
    expect(result.confidence).toBe(classify_intent(AMBIGUOUS_MESSAGE).confidence);
    expect(result.source).toBe("regex");
    return result;
  }

  it("behaves identically when no model is configured at all", async () => {
    await degraded_with(undefined);
  });

  it("behaves identically when the adapter reports itself unconfigured", async () => {
    const result = await degraded_with(new FakeModel({ configured: false, outcomes: [{ kind: "text", text: "{}" }] }));
    expect(result.fallback_reason).toBe("model-not-configured");
  });

  it("behaves identically on a provider error", async () => {
    const result = await degraded_with(scripted({ kind: "error", code: "provider_error" }));
    expect(result.fallback_reason).toBe("provider_error");
  });

  it("behaves identically on a timeout", async () => {
    const result = await degraded_with(scripted({ kind: "error", code: "timeout" }));
    expect(result.fallback_reason).toBe("timeout");
  });

  it("behaves identically when the adapter throws a non-domain error", async () => {
    const exploding: ModelPort = {
      provider: "exploding",
      is_configured: () => true,
      complete: () => Promise.reject(new Error("raw provider failure with customer text")),
    };
    const result = await degraded_with(exploding);
    expect(result.fallback_reason).toBe("model-error");
  });

  it("behaves identically on unparsable output", async () => {
    const result = await degraded_with(scripted({ kind: "text", text: "I am not JSON at all" }));
    expect(result.fallback_reason).toBe("model-output-invalid");
  });

  it("behaves identically on a confidence that is not a finite number", async () => {
    const result = await degraded_with(scripted({ kind: "text", text: '{"intent":"book","confidence":"high"}' }));
    expect(result.fallback_reason).toBe("model-output-invalid");
  });

  it("behaves identically on an intent outside the allow-list", async () => {
    const result = await degraded_with(proposing("delete_everything"));
    expect(result.fallback_reason).toBe("model-intent-not-allowed");
  });

  it("never escalates confidence above the model ceiling", async () => {
    const result = await classify_intent_hybrid(AMBIGUOUS_MESSAGE, { model: proposing("book", 1) });
    expect(result.confidence).toBe(MAX_MODEL_CONFIDENCE);
  });

  it("floors a non-positive asserted confidence at the unknown floor", async () => {
    const result = await classify_intent_hybrid(AMBIGUOUS_MESSAGE, { model: proposing("book", 0) });
    expect(result.confidence).toBe(UNKNOWN_CONFIDENCE);
  });
});

describe("parse_model_proposal", () => {
  it("rejects an array rather than unwrapping the object inside it", () => {
    expect(parse_model_proposal('[{"intent":"book","confidence":0.9}]')).toBeUndefined();
  });

  it("rejects an array wrapped in prose", () => {
    expect(parse_model_proposal('Here you go: [{"intent":"book","confidence":0.9}]')).toBeUndefined();
  });

  it("rejects a bare scalar", () => {
    expect(parse_model_proposal("42")).toBeUndefined();
  });

  it("rejects a missing intent", () => {
    expect(parse_model_proposal('{"confidence":0.9}')).toBeUndefined();
  });

  it("rejects a non-string intent", () => {
    expect(parse_model_proposal('{"intent":7,"confidence":0.9}')).toBeUndefined();
  });

  it("rejects a missing confidence", () => {
    expect(parse_model_proposal('{"intent":"book"}')).toBeUndefined();
  });

  it("rejects a non-finite confidence", () => {
    expect(parse_model_proposal('{"intent":"book","confidence":null}')).toBeUndefined();
  });

  it("accepts a valid object surrounded by prose", () => {
    const proposal = parse_model_proposal('Sure! {"intent":"book","confidence":0.8} hope that helps');
    expect(proposal).toMatchObject({ intent: "book", confidence: 0.8 });
  });

  it("normalises case and surrounding whitespace", () => {
    expect(parse_model_proposal('{"intent":"  BOOK ","confidence":0.8}')?.intent).toBe("book");
  });

  it("bounds the free-text reason it carries forward", () => {
    const reason = "r".repeat(500);
    const proposal = parse_model_proposal(`{"intent":"book","confidence":0.8,"reason":"${reason}"}`);
    expect(proposal?.reason?.length).toBe(200);
  });
});

describe("bound_confidence", () => {
  it("caps at the model ceiling", () => {
    expect(bound_confidence(0.99)).toBe(MAX_MODEL_CONFIDENCE);
  });

  it("floors a non-positive value", () => {
    expect(bound_confidence(0)).toBe(UNKNOWN_CONFIDENCE);
    expect(bound_confidence(-3)).toBe(UNKNOWN_CONFIDENCE);
  });

  it("floors a non-finite value", () => {
    expect(bound_confidence(Number.NaN)).toBe(UNKNOWN_CONFIDENCE);
  });

  it("passes an in-range value through", () => {
    expect(bound_confidence(0.55)).toBe(0.55);
  });
});

describe("classification telemetry", () => {
  it("records the accepted model classification", async () => {
    const metrics = new RecordingMetrics();
    await classify_intent_hybrid(AMBIGUOUS_MESSAGE, { model: proposing("book"), metrics });
    expect(metrics.calls).toContainEqual({
      name: "intent_classification_total",
      labels: { source: "model", intent: "book", result: "accepted" },
    });
  });

  it("records a model decline so an always-declining provider is visible", async () => {
    const metrics = new RecordingMetrics();
    await classify_intent_hybrid(AMBIGUOUS_MESSAGE, { model: proposing("unknown"), metrics });
    expect(metrics.calls).toContainEqual({
      name: "intent_classification_total",
      labels: { source: "model", intent: "unknown", result: "declined" },
    });
  });

  it("records the fallback reason so degradation is observable", async () => {
    const metrics = new RecordingMetrics();
    await classify_intent_hybrid(AMBIGUOUS_MESSAGE, {
      model: scripted({ kind: "error", code: "timeout" }),
      metrics,
    });
    expect(metrics.calls).toContainEqual({
      name: "intent_classification_total",
      labels: { source: "regex", intent: "unknown", result: "timeout" },
    });
  });

  it("never puts message content or a credential into a metric label", async () => {
    const metrics = new RecordingMetrics();
    const secret = "081234567890";
    await classify_intent_hybrid(`${AMBIGUOUS_MESSAGE} ${secret}`, { model: proposing("book"), metrics });
    for (const call of metrics.calls) {
      for (const value of Object.values(call.labels)) {
        expect(value).not.toContain(secret);
        expect(value.length).toBeLessThanOrEqual(128);
      }
    }
  });
});
