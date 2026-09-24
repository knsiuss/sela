/** Unit tests for golden-set retrieval recall. */
import { describe, expect, it, vi } from "vitest";
import {
  GoldenSetEvaluationError,
  evaluate_golden_set,
} from "../src/eval_golden_set.js";

const golden = [
  {
    question: "What is the late cancellation policy?",
    expected_doc_ids: ["sop_reschedule"],
    expected_action: "answer" as const,
  },
  {
    question: "Where is the dental clinic?",
    expected_doc_ids: ["clinic_location"],
    expected_action: "answer" as const,
  },
];

describe("evaluate_golden_set", () => {
  it("counts canonical chunk ids as recall hits and reports misses", async () => {
    const retrieve = vi.fn(async (question: string) =>
      question === golden[0]?.question
        ? ["sop_reschedule:chunk_0000"]
        : ["sop_reschedule:chunk_0001"],
    );

    const report = await evaluate_golden_set(golden, retrieve, 5);

    expect(report.total).toBe(2);
    expect(report.recall_at_k).toBe(0.5);
    expect(report.misses).toEqual([golden[1]?.question]);
    expect(retrieve).toHaveBeenCalledWith(golden[0]?.question, 5);
  });

  it("returns zero for an empty golden set", async () => {
    await expect(evaluate_golden_set([], async () => [])).resolves.toEqual({
      total: 0,
      recall_at_k: 0,
      misses: [],
    });
  });

  it("propagates retrieval failures instead of reporting a partial score", async () => {
    const retrieve = vi.fn(async () => {
      throw new Error("retrieval unavailable");
    });

    await expect(evaluate_golden_set(golden, retrieve)).rejects.toThrow(
      "retrieval unavailable",
    );
  });

  it("rejects an invalid cutoff", async () => {
    await expect(evaluate_golden_set([], async () => [], 0)).rejects.toBeInstanceOf(
      GoldenSetEvaluationError,
    );
  });
});
