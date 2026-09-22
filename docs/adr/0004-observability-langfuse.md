# ADR 0004 — Observability: Langfuse dulu

Status: Accepted (23 Sep 2026)
Context: butuh trace+evals volume chat tanpa pajak per-seat. Alternatif: LangSmith, Helicone.
Decision: Langfuse Cloud Hobby/Core; LangSmith Developer tier hanya untuk debug LangGraph saat build; Helicone bila butuh gateway caching. Bukti pricing: `docs/03-Technical/02-Recommended-Tech-Stack.md`.
Consequences: Plus: kurva volume murah + path self-host. Minus: evals kurang dalam vs LangSmith (mitigasi: keep Developer tier). Tinjau saat volume × retensi diketahui.
