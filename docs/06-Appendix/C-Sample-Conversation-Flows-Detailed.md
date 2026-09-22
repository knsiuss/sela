# C Sample Conversation Flows Detailed

> Status: baseline for builder. Source of truth for patterns lives in `02-Product/04-Conversation-Flows.md`.
> Related: `02-Product/01-Core-Features-and-Scope.md`, `02-Product/02-User-Personas-and-Journeys.md`, `03-Technical/08-RAG-and-Memory-Architecture.md`.
> Language rule: user-facing text in this file is English per `AGENTS.md`. Localized templates per market are a separate decision.

## 1. Global Agent Rules

1. Buttons are deterministic intents. Max 3 quick-replies or 2 CTAs per message. Labels start with a verb and stay under 20 characters. More than 3 options uses a list with max 10 items.
2. Free text is accepted only for date, time, address, and reason. The agent always reconfirms the canonical slot (day, date, time, zone, provider) via buttons before any write.
3. Slot writes use a TTL hold, a single-writer endpoint, a unique constraint on `(provider_id, start_time)`, and an idempotency key. Availability is revalidated at write time. The database is the source of truth, not RAG or checkpoint state.
4. Business-initiated messages outside the 24-hour window use approved templates by category (Utility, Authentication, Marketing). Inside a user-initiated session, free-form replies are allowed.
5. Human handoff is keyword-based (`OPERATOR`) plus automatic triggers. The handoff package includes identity, reason, timestamped transcript, escalation reason, and emotion flag. Fallback is a queue number plus callback estimate.
6. Hard escalation deny-list, regardless of confidence: emergency symptoms, mental health crisis, controlled medication, unverified identity or insurance, billing or claim disputes, explicit human request. Response is a single handoff message with emergency guidance. No further bot turns.

## 2. Dental and Clinic — Long Lead Time, Forgetfulness Risk

Context: recall cycles of 6 months, long lead times correlate with forgetting, one slot carries high cost and continuity risk. Policy prefers agreement plus deposit for repeat offenders and three-strikes over rigid fines.

```text
Agent: Reminder — dental checkup Thu Sep 25 15:30 with Dr. Ani. [Confirm] [Reschedule] [Cancel]
User: [Reschedule]
Agent: What works instead? Type a day, or pick: [Thu PM] [Fri AM] [Other day]
User: thursday afternoon please
Agent: Thu afternoon with Dr. Ani:
  1. Thu Sep 25 16:00 Dr. Ani
  2. Thu Sep 25 17:30 Dr. Budi
  [Pick 1] [Pick 2] [Other day] [Talk to staff]
User: [Pick 1]
Agent: Move to Thu Sep 25 16:00 Dr. Ani? [Yes, move it] [Keep old slot]
User: [Yes, move it]
Agent: Done — moved to Thu Sep 25 16:00. Reply OPERATOR anytime for staff.
```

Edge cases:

1. Late cancel under 24 hours is treated as no-show per policy, then the agent offers a waitlist slot and a deposit option for the next booking.
2. Insurance or identity not verified blocks the write and triggers staff handoff with the collected fields attached.
3. After-hours medical urgency bypasses booking and goes straight to emergency guidance plus staff paging.

## 3. Salon — Chair Utilization and Deposits

Context: one lost stylist hour cannot be recovered, last-minute gaps are hard to fill, portal rebooking at night matters. Deposits outperform post-visit fines and reduce disputes.

```text
Agent: Hair coloring Sat 14:00 with Sinta. [Confirm] [Reschedule] [Cancel]
User: [Reschedule]
Agent: Same-day options for Sat:
  1. Sat 15:30 Sinta
  2. Sat 17:00 Sinta
  Note: cancel under 24h forfeits deposit.
  [Pick 1] [Pick 2] [Portal link]
User: [Pick 2]
Agent: Confirm Sat 17:00 Sinta? [Yes, confirm] [Back]
User: [Yes, confirm]
Agent: Done — Sat 17:00 locked. Manage anytime here: [Open portal]
```

Edge cases:

1. Cancel releases the chair immediately to the FIFO waitlist with first-to-reply-wins semantics.
2. Stylist running late triggers an automatic offer to shift plus staff notification. No silent delay.
3. Night bookings route to the portal link when the channel cannot complete full booking.

## 4. HVAC — Emergency, Speed Under 5 Minutes, Job Scheduler Write

Context: calls spike seasonally, most web forms convert poorly versus calls, after-hours share is high, voicemail loses leads. A missed call carries high lost value. Booking must land in the job scheduler, not a generic calendar note.

```text
User: AC completely dead, house is hot
Agent: Is this an emergency right now, or can it wait until tomorrow? [Emergency now] [Tomorrow]
User: [Emergency now]
Agent: Send address + 1 photo of the unit. Tech on call will be paged.
User: <address + photo>
Agent: Booked — emergency visit today, window 16:00-18:00, tech Andi. Live updates here. Reply OPERATOR for dispatcher.
```

Edge cases:

1. Technician delay triggers de-escalation plus an automatic offer to shift the window. The customer gets an ETA, not a generic apology.
2. Peak-season cancel of a high-value job triggers an immediate callback task with a 5-minute target.
3. Non-emergency requests follow the standard pick-slot plus explicit confirm pattern and sync to the CRM job record.

## 5. Physiotherapy — Weekly Episodes, Adherence Risk

Context: weekly episodes, risk of dropout when the patient feels better, cost sensitivity multiplied by sessions. Tone stays supportive and avoids cost shaming.

```text
Agent: Knee session Wed 10:00 with Physio Rina. [Confirm] [Reschedule] [Cancel]
User: feeling better, want to cancel
Agent: Good progress. One evaluation session keeps the episode on track. [Keep Wed] [Reschedule] [Talk to therapist]
User: [Reschedule]
Agent: Options this week:
  1. Thu 11:00 Rina
  2. Fri 09:30 Rina
  [Pick 1] [Pick 2] [Talk to therapist]
User: [Pick 1]
Agent: Move to Thu 11:00 Rina? [Yes, move it] [Back]
User: [Yes, move it]
Agent: Done — Thu 11:00 locked. Reply OPERATOR anytime.
```

Edge cases:

1. Cancel is logged against adherence and triggers a recall offer, not a penalty threat.
2. Repeated reschedules trigger a therapist review task with the session history attached.
3. Cost questions route to a transparent per-session quote plus hardship or package options where the tenant allows them.

## 6. Builder Checklist

1. Every flow ends in one of four terminal states: confirmed write, rescheduled write, canceled release, or staff handoff with context.
2. Every write carries `tenant_id`, `appointment_id`, slot canonical string, provider, idempotency key, and `request_id` in logs. No full phone numbers or secrets in logs.
3. Every policy answer cites `doc_id` and `section` from RAG. Slot facts come from the slot engine or PMS adapter only.
4. Start with 100 percent human confirmation in week one, then relax to human-on-the-loop based on trace data and drop-off metrics.
