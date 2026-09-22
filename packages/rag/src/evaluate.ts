import type { GoldenItem } from "./types.js";

export interface EvalReport {
  total: number;
  recall_at_k: number;
  misses: string[];
}

/**
 * Score a golden set against a retrieve function.
 *
 * Recall@k = fraction of questions whose expected doc appears in top-k.
 * A miss means the knowledge is absent, chunked badly, or filtered out —
 * fix at the source document, never patch the prompt.
 *
 * Args:
 *   golden: Labeled questions with expected doc ids.
 *   retrieve: Function returning ranked chunk ids for a question.
 *   k: Cutoff rank.
 */
export async function evaluate_golden_set(
  golden: GoldenItem[],
  retrieve: (question: string, k: number) => Promise<string[]>,
  k = 5,
): Promise<EvalReport> {
  let hits = 0;
  const misses: string[] = [];
  for (const item of golden) {
    const ranked = await retrieve(item.question, k);
    const hit = item.expected_doc_ids.some((doc_id) =>
      ranked.some((chunk_id) => chunk_id.startsWith(`${doc_id}#`)),
    );
    if (hit) hits++;
    else misses.push(item.question);
  }
  return { total: golden.length, recall_at_k: golden.length === 0 ? 0 : hits / golden.length, misses };
}
