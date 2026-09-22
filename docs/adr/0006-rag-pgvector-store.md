# ADR 0006 — RAG: pgvector + LangGraph Store, slots never via retrieval

Status: Accepted (23 Sep 2026)
Context: butuh knowledge statis (SOP, pricelist, FAQ) + memory preferensi lintas-thread, tanpa DB vektor kedua. Alternatif: Qdrant/Weaviate/Milvus dedicated, ringkasan bebas sebagai memory.
Decision: 1 Postgres + pgvector untuk knowledge saja (hybrid FTS+vektor+RRF, filter tenant_id); memory via LangGraph Store namespace `[tenant_id, user_id]` Collection ber-skema; slot availability SELALU tool DB query + validasi kode. Bukti: `docs/03-Technical/08-RAG-and-Memory-Architecture.md` §14.
Consequences: Plus: 1 stateful system, eval Ragas sebelum tuning, nol risiko hallucinated slots. Minus: ekstrak ke Qdrant bila p95 retrieval/filter terbukti sesak (interface stabil, swap = config).
