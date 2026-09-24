/** Retrieval evaluation against a labeled vertical-specific golden set. */

/** One labeled golden-set question. */
export interface GoldenSetItem {
  expected_action: "answer" | "clarify" | "escalate";
  expected_doc_ids: string[];
  question: string;
}

/** Retrieval callback evaluated for each golden-set question. */
export type GoldenSetRetriever = (
  question: string,
  k: number,
) => Promise<ReadonlyArray<string>>;

/** Aggregate retrieval recall and missed questions. */
export interface EvalReport {
  misses: string[];
  recall_at_k: number;
  total: number;
}

/** Raised when the evaluation cutoff is invalid. */
export class GoldenSetEvaluationError extends Error {
  constructor(message: string) {
    super(`invalid golden set evaluation: ${message}`);
    this.name = "GoldenSetEvaluationError";
  }
}

function contains_expected_document(
  ranked_chunk_ids: ReadonlyArray<string>,
  expected_doc_ids: ReadonlyArray<string>,
): boolean {
  return expected_doc_ids.some((doc_id) => {
    const canonical_prefix = `${doc_id}:chunk_`;
    return ranked_chunk_ids.some(
      (chunk_id) => chunk_id === doc_id || chunk_id.startsWith(canonical_prefix),
    );
  });
}

/**
 * Compute question-level recall@k against ranked canonical chunk ids.
 *
 * A question is a hit when any expected document appears in the first `k`
 * results. Retrieval errors propagate so incomplete evaluation never looks
 * successful. An empty golden set reports zero rather than NaN.
 *
 * @param golden Labeled questions and expected document ids.
 * @param retrieve Retrieval callback returning ranked chunk ids.
 * @param k Positive result cutoff passed to the callback.
 * @ @returns Total questions, recall ratio, and missed questions.
 * @throws GoldenSetEvaluationError when k is not a positive integer.
 */
export async function evaluate_golden_set(
  golden: ReadonlyArray<GoldenSetItem>,
  retrieve: GoldenSetRetriever,
  k = 5,
): Promise<EvalReport> {
  if (!Number.isInteger(k) || k <= 0) {
    throw new GoldenSetEvaluationError("k must be a positive integer");
  }
  const misses: string[] = [];
  for (const item of golden) {
    const ranked_chunk_ids = await retrieve(item.question, k);
    if (!contains_expected_document(ranked_chunk_ids, item.expected_doc_ids)) {
      misses.push(item.question);
    }
  }
  return {
    total: golden.length,
    recall_at_k: golden.length === 0 ? 0 : (golden.length - misses.length) / golden.length,
    misses,
  };
}
