# Documentation

## Templates

- [Design Doc / RFC template](templates/design-doc-template.md) — full design doc before building a feature
- [ADR template](adr/ADR-000-template.md) — one decision, one entry (Context → Decision → Consequences)
- [ADR index](adr/README.md)

## When to use which

| Doc | Purpose | When |
|---|---|---|
| PRD | Problem definition (PM side) | Before any design work |
| One-Pager | 1-page pitch to stakeholders | Before full design doc |
| Design Doc / RFC | Full proposed design + alternatives | Before building anything non-trivial |
| ADR | Record a single decision | When a decision is made |
| Diagram (C4) | System structure at different zoom levels | Inside design doc |
| API Contract | Hard contract between services/times | With design doc, source of truth for codegen |
| Capacity & Cost | Traffic projection + infra cost | Production-facing projects |
| Runbook | On-call SOP | Before launch |
| Postmortem | Incident root cause + action items | After an incident |

For small/personal projects: **Design Doc + ADR** are already well above average.
