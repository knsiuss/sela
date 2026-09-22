---
name: sela-handoff-rules
description: First-principles escalation rules (D-05). Use whenever deciding autonomous vs human handling.
---

# Handoff Rules

Escalate to a human when the action is ANY of:
1. Irreversible (cancel, charge, message to the wrong person).
2. Liability-bearing (medical/financial/emergency, controlled substances, mental-health crisis → human + emergency services, zero extra bot replies).
3. Moves money (fees, deposits, refunds, disputes).
4. Caller identity unverifiable or insurance unverifiable.
5. Ambiguity below confidence threshold (0.7 default; calibrate from traces).
6. Business discretion (discounts, priority, exceptions).

Autonomous ONLY for reversible + low-stakes (check slot, hold, draft, reminder).
Agent = orchestrator (gather context → propose options → execute after approval). Human = decider.
Handoff package must arrive BEFORE the human connects: identity, reason, timestamped transcript, insurance, escalation reason, emotion flag. Timeout = deny by default.
