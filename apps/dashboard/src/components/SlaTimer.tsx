"use client";

/**
 * SLA countdown for one queue item.
 *
 * The urgency label and `data-sla-state` come from the domain SLA contract, so
 * the badge never invents its own deadline rule. The ticking text is
 * deliberately outside a live region: a per-second announcement would flood a
 * screen reader; the queue board announces state changes instead.
 */

import { useEffect, useState, type ReactElement } from "react";
import { sla_state_label, sla_view, type QueueItem } from "@/domain/operator_queue_board";
import { format_datetime } from "./format_datetime";
import { StatusBadge } from "./StatusBadge";
import { status_tone } from "./status_tone";

/** How often the countdown text refreshes. */
const TICK_MS = 30_000;

/** Props for {@link SlaTimer}. */
export interface SlaTimerProps {
  item: QueueItem;
  /** Injectable reference time; tests pass a fixed value for determinism. */
  now_ms?: number;
}

/**
 * Render the SLA deadline and urgency of one queue item.
 *
 * @param props - Queue item and an optional fixed reference time.
 * @returns The SLA badge and deadline text.
 */
export function SlaTimer(props: SlaTimerProps): ReactElement {
  const [now_ms, set_now_ms] = useState(() => props.now_ms ?? Date.now());

  useEffect(() => {
    if (props.now_ms !== undefined) return undefined;
    const timer = setInterval(() => set_now_ms(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [props.now_ms]);

  const sla = sla_view(props.item, new Date(now_ms));
  return (
    <span className="sla">
      <StatusBadge label={sla_state_label(sla.state)} tone={status_tone(sla.state)} status={sla.state} />
      <time dateTime={sla.due_at_iso}>{format_datetime(sla.due_at_iso)}</time>
      <span className="sla__remaining">
        {props.item.status === "resolved" ? "closed" : `${sla.minutes_remaining} min remaining`}
      </span>
    </span>
  );
}