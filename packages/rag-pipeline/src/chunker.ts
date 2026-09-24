/** Policy-aware Markdown chunking with bounded overlap and PII rejection. */
import {
  chunk_metadata_schema,
  type ChunkMetadata,
  type SopChunk,
} from "./rag_types.js";
import { assert_chunk_is_safe, scrub_pii_from_text } from "./scrub.js";

/** Lower bound for a context-preserving chunk. */
export const MIN_CHUNK_TOKENS = 300;

/** Hard upper bound for every emitted chunk. */
export const MAX_CHUNK_TOKENS = 600;

/** Target overlap ratio between consecutive chunks. */
export const OVERLAP_TARGET_RATIO = 0.12;

/** English-prose characters-per-token estimate used for local sizing. */
export const CHARS_PER_TOKEN = 4;

const CHUNK_SEPARATOR = "\n\n";
const MAX_CHUNK_CHARACTERS = MAX_CHUNK_TOKENS * CHARS_PER_TOKEN;

/** Metadata supplied once for every chunk in a source document. */
export interface ChunkDocumentInput {
  content: string;
  metadata: Omit<ChunkMetadata, "is_active" | "embedding_model" | "embedding_version"> &
    Partial<Pick<ChunkMetadata, "is_active" | "embedding_model" | "embedding_version">>;
}

interface PackedChunk {
  content: string;
  token_count: number;
}

/**
 * Estimate tokens without binding chunk sizing to one model tokenizer.
 *
 * @param text Text to measure.
 * @returns Estimated token count, or zero for empty text.
 */
export function estimate_token_count(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

/**
 * Build the stable identifier assigned to a document chunk.
 *
 * @param doc_id Source document id.
 * @param chunk_index Zero-based chunk position.
 * @returns Zero-padded identifier such as `sop_x:chunk_0003`.
 */
export function build_chunk_id(doc_id: string, chunk_index: number): string {
  return `${doc_id}:chunk_${String(chunk_index).padStart(4, "0")}`;
}

/**
 * Split Markdown into atomic headings, rules, table rows, and paragraphs.
 *
 * @param markdown_text Normalized Markdown source.
 * @returns Non-empty atomic units in source order.
 */
export function split_into_atomic_units(markdown_text: string): string[] {
  const units: string[] = [];
  let paragraph_lines: string[] = [];
  const flush_paragraph = (): void => {
    if (paragraph_lines.length > 0) {
      units.push(paragraph_lines.join("\n"));
      paragraph_lines = [];
    }
  };

  for (const line of markdown_text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") {
      flush_paragraph();
    } else if (trimmed.startsWith("#")) {
      flush_paragraph();
      units.push(trimmed);
    } else if (/^(\d+[.)]|[-*+])\s+\S/.test(trimmed) || trimmed.startsWith("|")) {
      flush_paragraph();
      units.push(trimmed);
    } else {
      paragraph_lines.push(line);
    }
  }
  flush_paragraph();
  return units.filter((unit) => unit.trim() !== "");
}

function split_long_word(word: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (const code_point of Array.from(word)) {
    if (current !== "" && current.length + code_point.length > MAX_CHUNK_CHARACTERS) {
      parts.push(current);
      current = "";
    }
    current += code_point;
  }
  if (current !== "") {
    parts.push(current);
  }
  return parts;
}

/**
 * Split an oversized atomic unit on words, then characters for long words.
 *
 * This deterministic fallback also handles uninterrupted text with no
 * sentence punctuation. Every returned part is at or below MAX_CHUNK_TOKENS.
 *
 * @param oversized_unit Atomic text known to exceed the token ceiling.
 * @returns Bounded text parts in source order.
 */
export function split_oversized_unit(oversized_unit: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (const word of oversized_unit.trim().split(/\s+/)) {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (candidate.length <= MAX_CHUNK_CHARACTERS) {
      current = candidate;
      continue;
    }
    if (current !== "") {
      parts.push(current);
      current = "";
    }
    if (word.length <= MAX_CHUNK_CHARACTERS) {
      current = word;
    } else {
      parts.push(...split_long_word(word));
    }
  }
  if (current !== "") {
    parts.push(current);
  }
  return parts;
}

function join_units(units: ReadonlyArray<string>): string {
  return units.join(CHUNK_SEPARATOR);
}

function build_overlap(previous_content: string, next_unit: string): string {
  const target_tokens = Math.round(
    estimate_token_count(previous_content) * OVERLAP_TARGET_RATIO,
  );
  const target_characters = target_tokens * CHARS_PER_TOKEN;
  const words = previous_content.trim().split(/\s+/);
  let overlap_words: string[] = [];
  for (let index = words.length - 1; index >= 0; index -= 1) {
    const candidate = [words[index] as string, ...overlap_words];
    if (candidate.join(" ").length > target_characters) {
      break;
    }
    overlap_words = candidate;
  }
  while (
    overlap_words.length > 0 &&
    estimate_token_count(join_units([overlap_words.join(" "), next_unit])) > MAX_CHUNK_TOKENS
  ) {
    overlap_words = overlap_words.slice(1);
  }
  return overlap_words.join(" ");
}

function to_packed_chunk(content: string): PackedChunk {
  return { content, token_count: estimate_token_count(content) };
}

function merge_short_middle_chunks(chunks: PackedChunk[]): PackedChunk[] {
  const merged = [...chunks];
  for (let index = 1; index < merged.length - 1; index += 1) {
    const previous = merged[index - 1] as PackedChunk;
    const current = merged[index] as PackedChunk;
    if (current.token_count >= MIN_CHUNK_TOKENS) {
      continue;
    }
    const combined = join_units([previous.content, current.content]);
    const replacement =
      estimate_token_count(combined) <= MAX_CHUNK_TOKENS
        ? [to_packed_chunk(combined)]
        : split_oversized_unit(combined).map(to_packed_chunk);
    merged.splice(index - 1, 2, ...replacement);
  }
  return merged;
}

function pack_bounded_units(atomic_units: string[]): PackedChunk[] {
  const bounded_units = atomic_units.flatMap((unit) =>
    estimate_token_count(unit) > MAX_CHUNK_TOKENS ? split_oversized_unit(unit) : [unit],
  );
  const packed: PackedChunk[] = [];
  let current_units: string[] = [];
  for (const unit of bounded_units) {
    if (
      current_units.length > 0 &&
      estimate_token_count(join_units([...current_units, unit])) > MAX_CHUNK_TOKENS
    ) {
      packed.push(to_packed_chunk(join_units(current_units)));
      current_units = [unit];
    } else {
      current_units.push(unit);
    }
  }
  if (current_units.length > 0) {
    packed.push(to_packed_chunk(join_units(current_units)));
  }
  return packed;
}

function add_bounded_overlap(chunks: PackedChunk[]): PackedChunk[] {
  return chunks.map((chunk, index) => {
    const previous = chunks[index - 1];
    if (previous === undefined) {
      return chunk;
    }
    const overlap = build_overlap(previous.content, chunk.content);
    return overlap === ""
      ? chunk
      : to_packed_chunk(join_units([overlap, chunk.content]));
  });
}

/**
 * Pack atomic units, retain short middle sections, and add bounded overlap.
 *
 * Undersized middle content is merged backward or re-split before overlap is
 * introduced. Every emitted candidate is then measured with the overlap and
 * separators included, so MAX_CHUNK_TOKENS remains a hard ceiling.
 *
 * @param atomic_units Atomic units in source order.
 * @returns Packed chunks with exact estimated token counts.
 */
export function pack_units_into_chunks(atomic_units: string[]): PackedChunk[] {
  const packed = merge_short_middle_chunks(pack_bounded_units(atomic_units));
  return add_bounded_overlap(packed);
}

function bound_scrubbed_chunks(chunks: PackedChunk[]): PackedChunk[] {
  return chunks.flatMap((chunk) =>
    chunk.token_count <= MAX_CHUNK_TOKENS
      ? [chunk]
      : split_oversized_unit(chunk.content).map(to_packed_chunk),
  );
}

/**
 * Chunk and scrub one tenant document into embed-ready chunks.
 *
 * Short middle sections are retained by merging them with preceding content;
 * when that would exceed the ceiling, the combined text is safely re-split.
 * PII scrubbing remains fail-closed and happens before any chunk is returned.
 *
 * @param document_text Raw Markdown source.
 * @param document_input Shared document metadata.
 * @returns Scrubbed chunks in document order with deterministic ids.
 * @throws UnsafeChunkError when unscrubbable secret material remains.
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
  const packed = pack_units_into_chunks(split_into_atomic_units(normalized_text));
  const scrubbed = packed.map((chunk) => {
    const content = scrub_pii_from_text(chunk.content);
    assert_chunk_is_safe(content);
    return to_packed_chunk(content);
  });
  return bound_scrubbed_chunks(scrubbed).map((chunk, chunk_index) => ({
    chunk_id: build_chunk_id(metadata.doc_id, chunk_index),
    content: chunk.content,
    metadata,
    token_count: chunk.token_count,
  }));
}
