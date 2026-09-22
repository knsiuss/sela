export interface ChunkMetadata {
  tenant_id: string;
  vertical: string;
  doc_id: string;
  section: string;
  locale: string;
  effective_from: string;
  source_uri: string;
}

export interface Chunk extends ChunkMetadata {
  chunk_id: string;
  content: string;
}

export interface ScoredChunk {
  chunk_id: string;
  content: string;
  score: number;
}

export interface GoldenItem {
  question: string;
  expected_doc_ids: string[];
  expected_action: "answer" | "clarify" | "escalate";
}
