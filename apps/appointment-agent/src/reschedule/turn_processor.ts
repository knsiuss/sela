/** Default tenant/conversation processor for the reschedule button state machine. */

import { createHash } from "node:crypto";
import { detect_handoff_reason } from "../handoff.js";
import { create_initial_appointment_state } from "../state.js";
import {
  HoldExpiredError,
  SlotUnavailableError,
  type CalendarPort,
} from "../tools/calendar.js";
import { HOLD_TTL_SECONDS } from "../tools/hold_ttl.js";
import type { GraphRunner, OutboundDraft, TurnProcessorInput } from "../worker/process_job.js";
import { parse_reschedule_button_action, type RescheduleButtonAction } from "./button_actions.js";
import {
  MAX_RESCHEDULE_SESSION_COUNTER,
  type RescheduleSession,
  type RescheduleSessionState,
} from "./session_model.js";
import type { RescheduleSessionScope, RescheduleSessionStore } from "./session_store.js";
import { build_reschedule_turn_draft } from "./turn_drafts.js";

/** Session retention aligned with the customer service conversation window. */
export const RESCHEDULE_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** Handoff tombstones remain longer than the ordinary service window. */
export const RESCHEDULE_HANDOFF_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Retryable optimistic-concurrency failure; no draft is returned to the sender. */
export class RescheduleTurnConflictError extends Error {
  /** Create a sanitized conflict signal. */
  constructor() {
    super("reschedule-session-concurrent-update");
    this.name = "RescheduleTurnConflictError";
  }
}

/** Dependencies for one tenant-scoped default turn processor. */
export interface RescheduleTurnProcessorOptions {
  session_store: RescheduleSessionStore;
  calendar: CalendarPort;
  graph_runner: GraphRunner;
  clock?: () => Date;
}

/**
 * Process one retained inbound turn into customer-safe drafts.
 *
 * The decrypted recipient and raw text are accepted only for this call. The
 * session store receives only validated identifiers, bounded slots, phase
 * fields, and timestamps. Calendar mutations are awaited before their matching
 * phase or success response is persisted.
 */
export class RescheduleTurnProcessor {
  private readonly session_store: RescheduleSessionStore;
  private readonly calendar: CalendarPort;
  private readonly graph_runner: GraphRunner;
  private readonly clock: () => Date;

  /** Create the default processor with explicit state and calendar boundaries. */
  constructor(options: RescheduleTurnProcessorOptions) {
    this.session_store = options.session_store;
    this.calendar = options.calendar;
    this.graph_runner = options.graph_runner;
    this.clock = options.clock ?? (() => new Date());
  }

  /**
   * Load, guard, and route one inbound turn.
   *
   * Unknown or stale buttons fail closed without calendar access. Duplicate
   * WAMIDs replay the persisted phase. A hold expiry advances the generation
   * and clears hold references without writing.
   */
  async process(input: TurnProcessorInput): Promise<OutboundDraft[]> {
    const scope = session_scope(input);
    let session = await this.session_store.load(scope);
    if (detect_handoff_reason(input.message.text_body) !== undefined) {
      return [await this.enter_handoff(input, scope, session)];
    }
    if (session?.phase === "handoff") {
      return [build_reschedule_turn_draft({ kind: "handoff" }, input.reply_target)];
    }
    session = await this.expire_hold(input, scope, session);
    if (session?.last_wamid === input.wamid) {
      return [render_phase(session, input.reply_target)];
    }
    if (input.message.message_kind === "button_reply") {
      return [await this.handle_button(input, scope, session, input.message.button_id ?? "")];
    }
    return [await this.handle_text(input, scope, session)];
  }

  private async handle_text(
    input: TurnProcessorInput,
    scope: RescheduleSessionScope,
    session: RescheduleSession | null,
  ): Promise<OutboundDraft> {
    if (session?.phase === "awaiting_confirmation") {
      return render_phase(session, input.reply_target);
    }
    const state = await this.graph_runner.invoke(
      create_initial_appointment_state(input.conversation_id, input.message),
    );
    if (state.needs_human) return this.enter_handoff(input, scope, session);
    if (session?.phase === "confirmed" && state.intent === "cancel") {
      return this.enter_handoff(input, scope, session);
    }
    if (is_offer_result(state)) return this.persist_offer(input, scope, session, state.candidate_slots);
    return build_reschedule_turn_draft({ kind: "graph", state }, input.reply_target);
  }

  private async persist_offer(
    input: TurnProcessorInput,
    scope: RescheduleSessionScope,
    session: RescheduleSession | null,
    candidate_slots: RescheduleSessionState["candidate_slots"],
  ): Promise<OutboundDraft> {
    const ordered_slots = [...candidate_slots]
      .sort((left, right) => left.start_iso.localeCompare(right.start_iso) || left.id.localeCompare(right.id))
      .slice(0, 2);
    const state: RescheduleSessionState = {
      phase: "offered",
      candidate_slots: ordered_slots,
      chosen_slot_id: null,
      hold_id: null,
      hold_expires_at_iso: null,
      offer_generation: next_generation(session?.offer_generation),
      last_wamid: input.wamid,
      expires_at_iso: this.session_expiry(),
    };
    const saved = await this.commit(scope, state, session?.version ?? null);
    return build_reschedule_turn_draft({ kind: "offer", session: saved }, input.reply_target);
  }

  private async handle_button(
    input: TurnProcessorInput,
    scope: RescheduleSessionScope,
    session: RescheduleSession | null,
    button_id: string,
  ): Promise<OutboundDraft> {
    const action = parse_reschedule_button_action(button_id);
    if (session === null || action === null || action.generation !== session.offer_generation) {
      return build_reschedule_turn_draft({ kind: "rejected" }, input.reply_target);
    }
    if (action.kind === "change_day" && session.phase === "offered") {
      return build_reschedule_turn_draft({ kind: "change_day" }, input.reply_target);
    }
    if (action.kind === "pick_slot" && session.phase === "offered") {
      return this.pick_slot(input, scope, session, action);
    }
    if (action.kind === "confirm_move" && session.phase === "awaiting_confirmation") {
      return this.confirm_move(input, scope, session);
    }
    if (action.kind === "confirm_cancel" && session.phase === "awaiting_confirmation") {
      return this.cancel_hold(input, scope, session);
    }
    return this.replay_terminal_action(input, scope, session, action);
  }

  private async pick_slot(
    input: TurnProcessorInput,
    scope: RescheduleSessionScope,
    session: RescheduleSession,
    action: Extract<RescheduleButtonAction, { kind: "pick_slot" }>,
  ): Promise<OutboundDraft> {
    const slot = session.candidate_slots[action.option - 1];
    if (slot === undefined || action.option > 2) return rejected(input.reply_target);
    let hold: Awaited<ReturnType<CalendarPort["hold_slot"]>>;
    try {
      hold = await this.calendar.hold_slot(
        slot.id,
        HOLD_TTL_SECONDS,
        operation_key("hold", scope, session.offer_generation, slot.id),
      );
    } catch (error) {
      if (error instanceof SlotUnavailableError || error instanceof HoldExpiredError) {
        return this.reoffer(input, scope, session, slot.id);
      }
      throw error;
    }
    const state: RescheduleSessionState = {
      ...to_state(session),
      phase: "awaiting_confirmation",
      chosen_slot_id: slot.id,
      hold_id: hold.hold_id,
      hold_expires_at_iso: hold.expires_at_iso,
      last_wamid: input.wamid,
      expires_at_iso: this.session_expiry(),
    };
    try {
      return render_phase(await this.commit(scope, state, session.version), input.reply_target);
    } catch (error) {
      if (!(error instanceof RescheduleTurnConflictError)) throw error;
      const latest = await this.session_store.load(scope);
      if (latest?.phase === "awaiting_confirmation" && latest.hold_id === hold.hold_id) {
        return render_phase(latest, input.reply_target);
      }
      try {
        await this.calendar.release_hold(hold.hold_id);
      } catch (cleanup_error) {
        throw new AggregateError([error, cleanup_error], "reschedule-hold-cleanup-failed");
      }
      throw error;
    }
  }

  private async confirm_move(
    input: TurnProcessorInput,
    scope: RescheduleSessionScope,
    session: RescheduleSession,
  ): Promise<OutboundDraft> {
    if (session.hold_id === null) throw new RescheduleTurnConflictError();
    try {
      await this.calendar.confirm_hold(
        session.hold_id,
        operation_key("confirm", scope, session.offer_generation, session.hold_id),
      );
    } catch (error) {
      if (error instanceof HoldExpiredError) {
        return this.reoffer(input, scope, session);
      }
      if (error instanceof SlotUnavailableError) {
        await this.calendar.release_hold(session.hold_id);
        return this.reoffer(input, scope, session);
      }
      throw error;
    }
    const state: RescheduleSessionState = {
      ...to_state(session),
      phase: "confirmed",
      hold_id: null,
      hold_expires_at_iso: null,
      last_wamid: input.wamid,
      expires_at_iso: this.session_expiry(),
    };
    return render_phase(await this.commit(scope, state, session.version), input.reply_target);
  }

  private async cancel_hold(
    input: TurnProcessorInput,
    scope: RescheduleSessionScope,
    session: RescheduleSession,
  ): Promise<OutboundDraft> {
    if (session.hold_id === null) throw new RescheduleTurnConflictError();
    await this.calendar.release_hold(session.hold_id);
    const state: RescheduleSessionState = {
      ...to_state(session),
      phase: "cancelled",
      hold_id: null,
      hold_expires_at_iso: null,
      last_wamid: input.wamid,
      expires_at_iso: this.session_expiry(),
    };
    return render_phase(await this.commit(scope, state, session.version), input.reply_target);
  }

  private async replay_terminal_action(
    input: TurnProcessorInput,
    scope: RescheduleSessionScope,
    session: RescheduleSession,
    action: RescheduleButtonAction,
  ): Promise<OutboundDraft> {
    if (session.phase === "confirmed" && action.kind === "confirm_move") {
      return render_phase(session, input.reply_target);
    }
    if (session.phase === "confirmed" && action.kind === "confirm_cancel") {
      return this.enter_handoff(input, scope, session);
    }
    if (session.phase === "cancelled" && action.kind === "confirm_cancel") {
      return render_phase(session, input.reply_target);
    }
    return rejected(input.reply_target);
  }

  private async expire_hold(
    input: TurnProcessorInput,
    scope: RescheduleSessionScope,
    session: RescheduleSession | null,
  ): Promise<RescheduleSession | null> {
    if (session?.phase !== "awaiting_confirmation" || !is_hold_expired(session, this.clock())) {
      return session;
    }
    const state: RescheduleSessionState = {
      ...to_state(session),
      phase: "offered",
      chosen_slot_id: null,
      hold_id: null,
      hold_expires_at_iso: null,
      offer_generation: next_generation(session.offer_generation),
      last_wamid: input.wamid,
      expires_at_iso: this.session_expiry(),
    };
    return this.commit(scope, state, session.version);
  }

  private async reoffer(
    input: TurnProcessorInput,
    scope: RescheduleSessionScope,
    session: RescheduleSession,
    excluded_slot_id?: string,
  ): Promise<OutboundDraft> {
    const state: RescheduleSessionState = {
      ...to_state(session),
      phase: "offered",
      candidate_slots: excluded_slot_id === undefined
        ? session.candidate_slots
        : session.candidate_slots.filter((slot) => slot.id !== excluded_slot_id),
      chosen_slot_id: null,
      hold_id: null,
      hold_expires_at_iso: null,
      offer_generation: next_generation(session.offer_generation),
      last_wamid: input.wamid,
      expires_at_iso: this.session_expiry(),
    };
    return render_phase(await this.commit(scope, state, session.version), input.reply_target);
  }

  private async enter_handoff(
    input: TurnProcessorInput,
    scope: RescheduleSessionScope,
    session: RescheduleSession | null,
  ): Promise<OutboundDraft> {
    if (session?.phase === "handoff") {
      return build_reschedule_turn_draft({ kind: "handoff" }, input.reply_target);
    }
    if (session?.phase === "awaiting_confirmation" && session.hold_id !== null) {
      await this.calendar.release_hold(session.hold_id);
    }
    const state: RescheduleSessionState = {
      phase: "handoff",
      candidate_slots: session?.candidate_slots ?? [],
      chosen_slot_id: null,
      hold_id: null,
      hold_expires_at_iso: null,
      offer_generation: session?.offer_generation ?? 1,
      last_wamid: input.wamid,
      expires_at_iso: this.session_expiry("handoff"),
    };
    await this.commit(scope, state, session?.version ?? null);
    return build_reschedule_turn_draft({ kind: "handoff" }, input.reply_target);
  }

  private async commit(
    scope: RescheduleSessionScope,
    state: RescheduleSessionState,
    expected_version: number | null,
  ): Promise<RescheduleSession> {
    const saved = await this.session_store.commit(scope, state, expected_version);
    if (saved === null) throw new RescheduleTurnConflictError();
    return saved;
  }

  private session_expiry(phase: RescheduleSessionState["phase"] = "offered"): string {
    const now = this.clock();
    if (!Number.isFinite(now.getTime())) throw new RescheduleTurnConflictError();
    const ttl_ms = phase === "handoff" ? RESCHEDULE_HANDOFF_TTL_MS : RESCHEDULE_SESSION_TTL_MS;
    return new Date(now.getTime() + ttl_ms).toISOString();
  }
}

function session_scope(input: TurnProcessorInput): RescheduleSessionScope {
  return { tenant_id: input.tenant_id, conversation_id: input.conversation_id };
}

function to_state(session: RescheduleSession): RescheduleSessionState {
  return {
    phase: session.phase,
    candidate_slots: session.candidate_slots.map((slot) => ({ ...slot })),
    chosen_slot_id: session.chosen_slot_id,
    hold_id: session.hold_id,
    hold_expires_at_iso: session.hold_expires_at_iso,
    offer_generation: session.offer_generation,
    last_wamid: session.last_wamid,
    expires_at_iso: session.expires_at_iso,
  };
}

function is_offer_result(state: Awaited<ReturnType<GraphRunner["invoke"]>>): boolean {
  return (state.intent === "reschedule" || state.intent === "book") && state.candidate_slots.length > 0;
}

function render_phase(session: RescheduleSession, to: string): OutboundDraft {
  if (session.phase === "offered") return build_reschedule_turn_draft({ kind: "offer", session }, to);
  if (session.phase === "awaiting_confirmation") {
    return build_reschedule_turn_draft({ kind: "reconfirm", session }, to);
  }
  if (session.phase === "confirmed") return build_reschedule_turn_draft({ kind: "confirmed", session }, to);
  if (session.phase === "cancelled") return build_reschedule_turn_draft({ kind: "cancelled", session }, to);
  return build_reschedule_turn_draft({ kind: "handoff" }, to);
}

function rejected(to: string): OutboundDraft {
  return build_reschedule_turn_draft({ kind: "rejected" }, to);
}

function is_hold_expired(session: RescheduleSession, now: Date): boolean {
  if (session.hold_expires_at_iso === null) return true;
  const expires_ms = Date.parse(session.hold_expires_at_iso);
  return !Number.isFinite(expires_ms) || expires_ms <= now.getTime();
}

function next_generation(current: number | undefined): number {
  const generation = (current ?? 0) + 1;
  if (!Number.isSafeInteger(generation) || generation > MAX_RESCHEDULE_SESSION_COUNTER) {
    throw new RescheduleTurnConflictError();
  }
  return generation;
}

function operation_key(
  operation: "hold" | "confirm",
  scope: RescheduleSessionScope,
  generation: number,
  resource_id: string,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([operation, scope.tenant_id, scope.conversation_id, generation, resource_id]))
    .digest("hex");
  return `reschedule-${operation}-v1:${digest}`;
}
