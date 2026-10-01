# Architecture

The canonical runtime architecture is documented in [01 — System Architecture (As-Is)](01-System-Architecture.md). It was last verified against the working tree on 2026-09-25 and distinguishes implemented behavior from product vision and open production work.

## Reading order

1. [System Architecture (As-Is)](01-System-Architecture.md) — components, runtime flows, state machines, data boundaries, failure semantics, and research sources.
2. [Recommended Tech Stack](02-Recommended-Tech-Stack.md) — evaluated technologies and version rationale.
3. [AI Agent Framework Choice](03-AI-Agent-Framework-Choice.md) — agent-framework decision context.
4. [Integrations](04-Integrations.md) — provider-facing integration details.
5. [Data Model and Database](05-Data-Model-and-Database.md) — schema and persistence decisions.
6. [Security, Privacy, and Compliance](06-Security-Privacy-Compliance.md) — control baseline; not a certification claim.
7. [Infrastructure and Deployment](07-Infrastructure-and-Deployment.md) — deployment topology and operational requirements.
8. [RAG and Memory Architecture](08-RAG-and-Memory-Architecture.md) — supporting package architecture.

## Document ownership

- This file is an index only; it must not contain a second, drifting architecture description.
- Runtime setup and local commands belong in `apps/appointment-agent/README.md`.
- Single technical decisions belong in `docs/adr/`.
- Operational response procedures belong in `docs/06-Appendix/J-Runbooks.md`.
- Source verification status belongs in `docs/06-Appendix/H-References-and-Sources.md`.

When runtime composition, migrations, provider adapters, or trust boundaries change, update the canonical as-is document in the same change.
