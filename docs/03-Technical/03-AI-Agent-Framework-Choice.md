# 03 — AI Agent Framework Choice

> Sumber: subagent deep-research framework (docs resmi tiap framework, Sep 2026). F = fakta teramati, I = interpretasi.

## Matriks

| Dimensi | LangGraph | OpenAI Agents SDK | Microsoft Agent Framework | CrewAI |
|---|---|---|---|---|
| Cyclic graphs | F: cyclical graphs untuk agent runtimes — https://www.langchain.com/blog/langgraph | F: agen + handoffs (triage → spesialis) — https://openai.github.io/openai-agents-python/agents/ ; I: handoff-sentris, bukan graph primitive | F: graph-based workflows + sequential/concurrent/handoff/group-chat — https://learn.microsoft.com/en-us/agent-framework/overview/ | F: Flows `@start/@listen/@router` + state — https://docs.crewai.com/en/concepts/flows ; I: routing event, bukan graph-with-checkpoint |
| Persistence | F: Checkpointer (thread: continuity, HITL, time-travel, fault tolerance) + Store (cross-thread); InMemory/SQLite dev, Postgres/Mongo prod — https://docs.langchain.com/oss/python/langgraph/persistence | F: Sessions (SQLite/AsyncSQLite/SQLAlchemy/Mongo/API) + `RunState.to_string/to_json` — https://openai.github.io/openai-agents-python/sessions/ | F: workflow checkpointing bawaan; I/Risiko: 1 laporan Nov 2025 sulit eksternalisasi checkpoint ke distributed cache (InMemory default; Json/FileSystem store jalan keluar) — https://github.com/microsoft/agent-framework/discussions/2305 (satu laporan) | F: Flow persistence + `@persist` + memory LanceDB — https://docs.crewai.com/en/concepts/flows |
| HITL interrupt | F: `interrupt()` dinamis + resume `Command`; `HumanInTheLoopMiddleware(interrupt_on=...)` approve/edit/reject/respond; wajib checkpointer + `thread_id` — https://docs.langchain.com/oss/python/langgraph/interrupts | F: `needs_approval` fail-closed; `interruptions` run-wide; resolve `state.approve/reject` — https://openai.github.io/openai-agents-python/human_in_the_loop/ | F: `RequestInfoEvent` → `SendResponseAsync`; checkpoint simpan pending; resume via `checkpoint_id` — https://learn.microsoft.com/en-us/agent-framework/workflows/human-in-the-loop | F: `@human_feedback` + pola webhook `Pending Human Input` — https://docs.crewai.com/v1.15.21/en/learn/human-feedback-in-flows |
| Guardrails | I: tidak ada primitif khusus; pola = conditional interrupt / node validasi | F: input/output/tool guardrails + tripwire exceptions; tool guardrails hanya `FunctionTool` — https://openai.github.io/openai-agents-python/guardrails/ | F: builder implementasi mitigasi sendiri — https://learn.microsoft.com/en-us/agent-framework/overview/ | I: tidak teramati primitif khusus |
| Observability | F: LangSmith tracing — https://docs.langchain.com/oss/python/langgraph/observability | F: halaman Tracing khusus — https://openai.github.io/openai-agents-python/tracing/ | F: OpenTelemetry GenAI conventions — https://learn.microsoft.com/en-us/agent-framework/agents/observability | F: built-in tracing → dashboard AMP — https://docs.crewai.com/v1.15.21/en/observability/tracing |

## Kematangan 2026

- F: `microsoft/autogen` maintenance mode ("New users should start with Microsoft Agent Framework") — https://github.com/microsoft/autogen. MAF = successor resmi SK + AutoGen, ada migration guide.
- Belum verifikasi primer: klaim "MAF 1.0 GA April 2026" hanya sekunder — jangan jadi fakta.

## Rekomendasi: LangGraph (default, sudah dipakai scaffold)

Satu-satunya yang primitif `interrupt() + checkpointer + thread_id + time-travel` dirancang untuk pause indefinite + resume + recovery — pasangan alami slot-hold + konfirmasi. Langkah aman: 1 StateGraph per booking `thread_id`; SQLite dev → Postgres prod; `interrupt()` sebelum tulis final; hold TTL di DB di luar state LLM.
Alternatif: OpenAI Agents SDK bila OpenAI-first + butuh tripwire/handoffs termatang (terima orkestrasi handoff-sentris). MAF: tunda kecuali siap tanggung framework muda + verifikasi checkpoint terdistribusi. CrewAI: terlemah untuk transactional booking state machine.
