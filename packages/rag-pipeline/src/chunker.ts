/** Policy-aware chunking: split SOP Markdown into rule-atomic chunks.
 *
 * Implements ingestion steps 2-3 of doc 08: normalize Markdown, then split
 * into 300-600 token chunks with 10-15% overlap without ever splitting a
 * policy rule. PII scrubbing lives in scrub.ts and runs after this step.
 */
import {
  chunk_metadata_schema,
  type ChunkMetadata,
  type SopChunk,
} from "./rag_types.js";
import { assert_chunk_is_safe, scrub_pii_from_text } from "./scrub.js";

/** Lower bound for a chunk: smaller chunks lose the policy context. */
export const MIN_CHUNK_TOKENS = 300;

/** Upper bound for a chunk: larger chunks dilute vector similarity. */
export const MAX_CHUNK_TOKENS = 600;

/** Target overlap between consecutive chunks, inside the mandated 10-15%. */
export const OVERLAP_TARGET_RATIO = 0.12;

/** Characters per token estimate for English prose (~4, OpenAI tiktoken rule). */
export const CHARS_PER_TOKEN = 4;

/** Extra fields the caller supplies per source document. */
export interface ChunkDocumentInput {
  content: string;
  metadata: Omit<ChunkMetadata, "is_active" | "embedding_model" | "embedding_version"> &
    Partial<Pick<ChunkMetadata, "is_active" | "embedding_model" | "embedding_version">>;
}

/**
 * Estimate token count without a tokenizer dependency.
 *
 * Uses the 4-chars-per-token heuristic. Accurate enough for chunk sizing
 * (not for billing), and keeps the pipeline dependency-free and local-first.
 *
 * @param text Text to measure.
 * @returns Estimated token count, at least 1 for non-empty text.
 */
export function estimate_token_count(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

/**
 * Build a deterministic chunk id stable across re-ingestions of one doc.
 *
 * @param doc_id Source document id.
 * @param chunk_index Zero-based position of the chunk in the document.
 * @returns Chunk id such as sop_reschedule_v3:chunk_0003.
 */
export function build_chunk_id(doc_id: string, chunk_index: number): string {
  return `${doc_id}:chunk_${String(chunk_index).padStart(4, "0")}`;
}

/**
 * Split Markdown into atomic units that must never be torn apart.
 *
 * A unit is a heading-led section, a list item (including numbered policy
 * rules), a table row block, or a plain paragraph. Policy rules survive
 * because numbered and bulleted items are always kept whole.
 *
 * @param markdown_text Normalized Markdown source.
 * @returns Atomic text units in document order.
 */
export function split_into_atomic_units(markdown_text: string): string[] {
  const units: string[] = [];
  const lines = markdown_text.split("\n");
  let paragraph_lines: string[] = [];

  const flush_paragraph = (): void => {
    if (paragraph_lines.length > 0) {
      units.push(paragraph_lines.join("\n"));
      paragraph_lines = [];
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") {
      flush_paragraph();
      continue;
    }
    if (trimmed.startsWith("#")) {
      flush_paragraph();
      units.push(trimmed);
      continue;
    }
    if (/^(\d+[.)]|[-*+])\s+\S/.test(trimmed) || trimmed.startsWith("|")) {
      flush_paragraph();
      units.push(trimmed);
      continue;
    }
    paragraph_lines.push(line);
  }
  flush_paragraph();
  return units.filter((unit) => unit.trim() !== "");
}

/**
 * Split an oversized atomic unit by sentences as a last resort.
 *
 * Used only when a single rule exceeds MAX_CHUNK_TOKENS on its own. Sentence
 * order is preserved so the fallback chunks still read coherently.
 *
 * @param oversized_unit Single atomic unit above the token ceiling.
 * @returns Sentence groups that each fit the ceiling.
 */
export function split_oversized_unit(oversized_unit: string): string[] {
  const sentences = oversized_unit.match(/[^.!?\n]+[.!?]+["']?|\S[^.!?]*$/g) ?? [
    oversized_unit,
  ];
  const parts: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    const candidate = current === "" ? sentence.trim() : `${current} ${sentence.trim()}`;
    if (
      estimate_token_count(candidate) > MAX_CHUNK_TOKENS &&
      current !== ""
    ) {
      parts.push(current);
      current = sentence.trim();
    } else {
      current = candidate;
    }
  }
  if (current !== "") {
    parts.push(current);
  }
  return parts;
}

interface PackedChunk {
  token_count: number;
  content: string;
}

/**
 * Greedily pack atomic units into chunks within the token bounds.
 *
 * Units are appended until adding another would exceed MAX_CHUNK_TOKENS.
 * Each chunk (except the first) starts with trailing text from the previous
 * chunk sized at OVERLAP_TARGET_RATIO, giving the mandated 10-15% overlap.
 *
 * @param atomic_units Units from split_into_atomic_units, in order.
 * @returns Packed chunk texts with token counts.
 */
export function pack_units_into_chunks(atomic_units: string[]): PackedChunk[] {
  const expanded_units: string[] = [];
  for (const unit of atomic_units) {
    if (estimate_token_count(unit) > MAX_CHUNK_TOKENS) {
      expanded_units.push(...split_oversized_unit(unit));
    } else {
      expanded_units.push(unit);
    }
  }

  const packed: PackedChunk[] = [];
  let current_units: string[] = [];
  let current_tokens = 0;

  const flush_current = (): void => {
    if (current_units.length === 0) {
      return;
    }
    const content = current_units.join("\n\n");
    packed.push({ content, token_count: estimate_token_count(content) });
  };

  const overlap_prefix_for = (previous: string): string => {
    const overlap_tokens = Math.round(
      estimate_token_count(previous) * OVERLAP_TARGET_RATIO,
    );
    if (overlap_tokens <= 0) {
      return "";
    }
    const words = previous.split(/\s+/);
    const overlap_chars = overlap_tokens * CHARS_PER_TOKEN;
    let taken = "";
    for (let index = words.length - 1; index >= 0; index -= 1) {
      const word = words[index] as string;
      const candidate = taken === "" ? word : `${word} ${taken}`;
      if (candidate.length > overlap_chars && taken !== "") {
        break;
      }
      taken = candidate;
    }
    return taken;
  };

  for (const unit of expanded_units) {
    const unit_tokens = estimate_token_count(unit);
    if (
      current_units.length > 0 &&
      current_tokens + unit_tokens > MAX_CHUNK_TOKENS
    ) {
      flush_current();
      const previous = packed[packed.length - 1]?.content ?? "";
      const overlap = overlap_prefix_for(previous);
      current_units = overlap === "" ? [] : [overlap];
      current_tokens = estimate_token_count(overlap);
    }
    current_units.push(unit);
    current_tokens += unit_tokens;
  }
  flush_current();
  return packed;
}

/**
 * Chunk one source document into embed-ready SOP chunks.
 *
 * Normalizes line endings, splits into rule-atomic chunks, scrubs PII, and
 * validates metadata. Chunks below MIN_CHUNK_TOKENS are kept only when they
 * are the final chunk, so short closing sections are not silently dropped.
 * Chunks failing the safety check raise UnsafeChunkError (fail-closed).
 *
 * @param document_text Raw Markdown source for one tenant document.
 * @param document_input Base metadata shared by all chunks of the document.
 * @returns Embed-ready chunks in document order.
 * @throws UnsafeChunkError when a chunk carries unscrubbable secrets.
 */
export function split_document_into_chunks(
  document_text: string,
  document_input: ChunkDocumentInput,
): SopChunk[] {
  const metadata = chunk_metadata_schema.parse(document_input.metadata);
  const normalized_text = document_text.replace(/\r\n/g, "\n").trim();
  if (normalized_text === "") {
    return [];
  }
  const atomic_units = split_into_atomic_units(normalized_text);
  const packed = pack_units_into_chunks(atomic_units);

  const chunks: SopChunk[] = [];
  packed.forEach((item, chunk_index) => {
    const is_last = chunk_index === packed.length - 1;
    if (!is_last && item.token_count < MIN_CHUNK_TOKENS) {
      return;
    }
    const scrubbed = scrub_pii_from_text(item.content);
    assert_chunk_is_safe(scrubbed);
    const token_count = estimate_token_count(scrubbed);
    chunks.push({
      chunk_id: build_chunk_id(metadata.doc_id, chunk_index),
      content: scrubbed,
      metadata,
      token_count,
    });
  });
  return chunks;
}
