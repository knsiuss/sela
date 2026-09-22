import type { Chunk, ChunkMetadata } from "./types.js";

const TARGET_MIN_TOKENS = 300;
const TARGET_MAX_TOKENS = 600;
const OVERLAP_RATIO = 0.12;

// Rough token estimate (chars/4). Exact tokenizer binds us to one model;
// retrieval quality depends on section boundaries, not exact counts.
function estimate_tokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function split_paragraphs(section: string): string[] {
  return section.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
}

function split_sentences(paragraph: string): string[] {
  return paragraph.split(/(?<=[.!?])\s+/).map((part) => part.trim()).filter(Boolean);
}

// Units for accumulation: paragraphs, with overlong paragraphs
// further split by sentence so a wall of text still breaks.
function split_units(section: string): string[] {
  const units: string[] = [];
  for (const paragraph of split_paragraphs(section)) {
    if (estimate_tokens(paragraph) <= TARGET_MAX_TOKENS) {
      units.push(paragraph);
      continue;
    }
    units.push(...split_sentences(paragraph));
  }
  return units;
}

/**
 * Split markdown into chunks by semantic section (## headings).
 *
 * Small sections merge up to the target window; oversized sections split
 * by paragraph with overlap. A policy rule is never split: sections under
 * the max stay whole even if short.
 *
 * Args:
 *   markdown: Normalized markdown source.
 *   base: Metadata shared by all chunks from this document.
 *
 * Returns:
 *   Chunks with stable ids `{doc_id}#n`.
 */
export function chunk_markdown(markdown: string, base: Omit<ChunkMetadata, "section">): Chunk[] {
  const sections = markdown.split(/^##\s+/m).map((part) => part.trim()).filter(Boolean);
  const chunks: Chunk[] = [];
  let index = 0;
  const push = (section: string, content: string) => {
    chunks.push({ ...base, section, chunk_id: `${base.doc_id}#${index++}`, content });
  };

  for (const section of sections) {
    const [heading, ...rest] = section.split("\n");
    const body = rest.join("\n").trim();
    const tokens = estimate_tokens(body);
    if (tokens <= TARGET_MAX_TOKENS) {
      push(heading.trim(), body);
      continue;
    }
    // Oversized: accumulate units up to max, then overlap back.
    const units = split_units(body);
    let current: string[] = [];
    let current_tokens = 0;
    const flush = () => {
      if (current.length > 0) push(heading.trim(), current.join("\n\n"));
    };
    for (const unit of units) {
      const unit_tokens = estimate_tokens(unit);
      if (current_tokens + unit_tokens > TARGET_MAX_TOKENS && current.length > 0) {
        flush();
        const overlap_count = Math.max(1, Math.floor(current.length * OVERLAP_RATIO));
        current = current.slice(-overlap_count);
        current_tokens = current.reduce((sum, part) => sum + estimate_tokens(part), 0);
      }
      current.push(unit);
      current_tokens += unit_tokens;
    }
    flush();
    void TARGET_MIN_TOKENS;
  }
  return chunks;
}
