# ADR 0002 — Runtime framework: LangGraph TypeScript

Status: Accepted (23 Sep 2026)
Context: state machine booking + interrupt sebelum tulis irreversibel + guardrails. Alternatif: CrewAI, MS Agent Framework, OpenAI Agents SDK.
Decision: LangGraph (`interrupt()` + checkpointer + `thread_id` + time-travel). Bukti penuh: `docs/03-Technical/03-AI-Agent-Framework-Choice.md`.
Consequences: Plus: pause indefinite + resume + recovery alami untuk slot-hold. Minus: terikat ekosistem LangChain observability (mitigasi: Langfuse agnostik).
