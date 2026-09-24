import { describe, expect, it, vi } from "vitest";
import type { InboundMessageRecord } from "../src/ingress/inbound_store.js";
import { AesGcmRecipientCipher } from "../src/security/recipient_cipher.js";
import type { AppointmentStateType } from "../src/state.js";
import type { CalendarPort } from "../src/tools/calendar.js";
import {
  JobProcessingError,
  process_job,
  type GraphRunner,
  type TurnProcessor,
} from "../src/worker/process_job.js";
import type { JobLifecycleStore } from "../src/worker/job_store.js";
import type { InboundLoader } from "../src/worker/inbound_loader.js";
import type { ClaimedWebhookJob } from "../src/worker/job_claim.js";

const RECIPIENT_PHONE = "+12025550123";
const RECIPIENT_CIPHER = new AesGcmRecipientCipher(Buffer.alloc(32, 9));
const RECORD: InboundMessageRecord = {
  tenant_id: "42",
  wamid: "wamid.process-test",
  conversation_id: "conversation-process",
  message_type: "text",
  button_id: null,
  sender_ref: "sender-reference-process",
  reply_target_ciphertext: RECIPIENT_CIPHER.encrypt(RECIPIENT_PHONE),
  message_text: "I want to reschedule",
  received_at: "2026-09-24T08:00:00.000Z",
  expires_at: "2099-01-01T00:00:00.000Z",
  processed_at: null,
};

const JOB: ClaimedWebhookJob = {
  id: "job-1",
  tenant_id: "42",
  request_id: "request-1",
  wamid: RECORD.wamid,
  conversation_id: RECORD.conversation_id,
  received_at_iso: RECORD.received_at,
  attempts: 1,
};

function final_state(overrides: Partial<AppointmentStateType> = {}): AppointmentStateType {
  return {
    conversation_id: RECORD.conversation_id,
    raw_message: RECORD.message_text,
    button_id: undefined,
    intent: "reschedule",
    confidence: 0.8,
    candidate_slots: [],
    chosen_slot_id: undefined,
    hold: undefined,
    customer_confirmed: false,
    needs_human: false,
    human_summary: undefined,
    done: true,
    ...overrides,
  };
}

function make_dependencies(overrides: {
  record?: InboundMessageRecord | null;
  graph?: GraphRunner;
  lifecycle?: JobLifecycleStore;
  recipient_cipher?: AesGcmRecipientCipher;
} = {}) {
  const loader: InboundLoader = {
    load: vi.fn(async () => ("record" in overrides ? overrides.record ?? null : RECORD)),
    mark_processed: vi.fn(async () => undefined),
  };
  const lifecycle: JobLifecycleStore = overrides.lifecycle ?? {
    complete: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
  };
  const graph: GraphRunner = overrides.graph ?? { invoke: vi.fn(async () => final_state()) };
  const calendar = {
    list_slots: vi.fn(async () => []),
    hold_slot: vi.fn(),
    confirm_hold: vi.fn(),
    release_hold: vi.fn(),
    cancel_booking: vi.fn(),
  } as unknown as CalendarPort;
  return {
    loader,
    lifecycle,
    graph,
    calendar,
    recipient_cipher: overrides.recipient_cipher ?? RECIPIENT_CIPHER,
  };
}

describe("process_job", () => {
  it("loads the retained message, invokes the graph, marks it processed, and returns drafts", async () => {
    const dependencies = make_dependencies();
    const drafts = await process_job({
      job: JOB,
      inbound_loader: dependencies.loader,
      recipient_cipher: dependencies.recipient_cipher,
      calendar: dependencies.calendar,
      lifecycle: dependencies.lifecycle,
      graph_runner: dependencies.graph,
    });

    expect(drafts).toEqual([
      {
        to: RECIPIENT_PHONE,
        message_type: "text",
        text: "We received your request. Our team will follow up with the next step.",
        inbound_wamid: JOB.wamid,
        turn_id: "0",
      },
    ]);
    expect(dependencies.loader.load).toHaveBeenCalledWith("42", RECORD.wamid);
    expect(dependencies.loader.mark_processed).toHaveBeenCalledWith(
      "42",
      RECORD.wamid,
      expect.any(String),
    );
    expect(dependencies.lifecycle.complete).toHaveBeenCalledWith(JOB);
    const graph_state = vi.mocked(dependencies.graph.invoke).mock.calls[0]?.[0];
    expect(JSON.stringify(graph_state)).not.toContain(RECIPIENT_PHONE);
    expect(JSON.stringify(graph_state)).not.toContain(RECORD.reply_target_ciphertext!);
  });

  it("does not deliver a same-tenant replay after the inbound row is processed", async () => {
    const dependencies = make_dependencies({
      record: { ...RECORD, processed_at: "2026-09-24T08:01:00.000Z" },
    });
    const deliver = vi.fn(async () => undefined);

    await expect(process_job({
      job: JOB,
      inbound_loader: dependencies.loader,
      recipient_cipher: dependencies.recipient_cipher,
      calendar: dependencies.calendar,
      lifecycle: dependencies.lifecycle,
      graph_runner: dependencies.graph,
      deliver,
    })).resolves.toEqual([]);

    expect(deliver).not.toHaveBeenCalled();
    expect(dependencies.loader.mark_processed).not.toHaveBeenCalled();
    expect(dependencies.lifecycle.complete).toHaveBeenCalledWith(JOB);
  });

  it("uses an injected turn processor before delivery without invoking the legacy graph", async () => {
    const dependencies = make_dependencies();
    const deliver = vi.fn(async () => undefined);
    const turn_processor: TurnProcessor = {
      process: vi.fn(async () => [{
        to: RECIPIENT_PHONE,
        message_type: "text" as const,
        text: "Choose a current time.",
      }]),
    };

    const drafts = await process_job({
      job: JOB,
      inbound_loader: dependencies.loader,
      recipient_cipher: dependencies.recipient_cipher,
      calendar: dependencies.calendar,
      lifecycle: dependencies.lifecycle,
      graph_runner: dependencies.graph,
      turn_processor,
      deliver,
    });

    expect(turn_processor.process).toHaveBeenCalledWith(expect.objectContaining({
      tenant_id: "42",
      conversation_id: RECORD.conversation_id,
      wamid: RECORD.wamid,
      reply_target: RECIPIENT_PHONE,
      message: expect.objectContaining({ button_id: undefined, text_body: RECORD.message_text }),
    }));
    expect(dependencies.graph.invoke).not.toHaveBeenCalled();
    expect(deliver).toHaveBeenCalledWith("42", [expect.objectContaining({ inbound_wamid: JOB.wamid, turn_id: "0" })]);
    expect(drafts).toEqual([expect.objectContaining({ inbound_wamid: JOB.wamid, turn_id: "0" })]);
    expect(dependencies.lifecycle.complete).toHaveBeenCalledWith(JOB);
  });

  it("leaves max-length WAMID idempotency derivation to the sender", async () => {
    const max_length_wamid = `wamid-${"x".repeat(122)}`;
    const max_length_job = { ...JOB, wamid: max_length_wamid };
    const max_length_record = { ...RECORD, wamid: max_length_wamid };
    const dependencies = make_dependencies({ record: max_length_record });

    const drafts = await process_job({
      job: max_length_job,
      inbound_loader: dependencies.loader,
      recipient_cipher: dependencies.recipient_cipher,
      calendar: dependencies.calendar,
      lifecycle: dependencies.lifecycle,
      graph_runner: dependencies.graph,
    });

    expect(drafts[0]).toMatchObject({ inbound_wamid: max_length_wamid, turn_id: "0" });
    expect(drafts[0]).not.toHaveProperty("idempotency_key");
  });

  it("passes a persisted button action into the graph state", async () => {
    const dependencies = make_dependencies({
      record: {
        ...RECORD,
        wamid: "wamid.button-process",
        message_type: "button_reply",
        button_id: "pick_slot_1",
        message_text: "Pick slot 1",
      },
    });

    await process_job({
      job: { ...JOB, wamid: "wamid.button-process" },
      inbound_loader: dependencies.loader,
      recipient_cipher: dependencies.recipient_cipher,
      calendar: dependencies.calendar,
      lifecycle: dependencies.lifecycle,
      graph_runner: dependencies.graph,
    });

    const graph_state = vi.mocked(dependencies.graph.invoke).mock.calls[0]?.[0];
    expect(graph_state?.button_id).toBe("pick_slot_1");
  });

  it("does not mark the job complete when outbound delivery fails", async () => {
    const dependencies = make_dependencies();
    const deliver = vi.fn(async () => {
      throw new JobProcessingError("outbound_delivery_failed");
    });

    await expect(
      process_job({
        job: JOB,
        inbound_loader: dependencies.loader,
        recipient_cipher: dependencies.recipient_cipher,
        calendar: dependencies.calendar,
        lifecycle: dependencies.lifecycle,
        graph_runner: dependencies.graph,
        deliver,
      }),
    ).rejects.toMatchObject({ code: "outbound_delivery_failed" });

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(dependencies.loader.mark_processed).not.toHaveBeenCalled();
    expect(dependencies.lifecycle.complete).not.toHaveBeenCalled();
    expect(dependencies.lifecycle.fail).toHaveBeenCalledWith(
      JOB,
      "outbound_delivery_failed",
      expect.any(Date),
    );
  });

  it("marks a missing retained row as a skipped terminal failure", async () => {
    const dependencies = make_dependencies({ record: null });
    const promise = process_job({
      job: JOB,
      inbound_loader: dependencies.loader,
      recipient_cipher: dependencies.recipient_cipher,
      calendar: dependencies.calendar,
      lifecycle: dependencies.lifecycle,
      graph_runner: dependencies.graph,
    });

    await expect(promise).rejects.toMatchObject({
      name: "JobProcessingError",
      is_skipped: true,
    });
    expect(dependencies.lifecycle.fail).toHaveBeenCalledWith(JOB, "missing_inbound_message");
    expect(dependencies.graph.invoke).not.toHaveBeenCalled();
  });

  it("fails closed for an unreasonably future-dated inbound timestamp", async () => {
    const dependencies = make_dependencies({
      record: { ...RECORD, received_at: "2026-09-26T12:10:00.000Z" },
    });
    await expect(
      process_job({
        job: JOB,
        inbound_loader: dependencies.loader,
        recipient_cipher: dependencies.recipient_cipher,
        calendar: dependencies.calendar,
        lifecycle: dependencies.lifecycle,
        graph_runner: dependencies.graph,
        clock: () => new Date("2026-09-26T12:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "inbound_timestamp_in_future", is_skipped: true });
    expect(dependencies.graph.invoke).not.toHaveBeenCalled();
  });

  it("does not send free-form replies after the 24-hour service window", async () => {
    const dependencies = make_dependencies({
      record: { ...RECORD, received_at: "2026-09-25T08:00:00.000Z" },
    });
    await expect(
      process_job({
        job: JOB,
        inbound_loader: dependencies.loader,
        recipient_cipher: dependencies.recipient_cipher,
        calendar: dependencies.calendar,
        lifecycle: dependencies.lifecycle,
        graph_runner: dependencies.graph,
        clock: () => new Date("2026-09-26T12:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "service_window_expired", is_skipped: true });
    expect(dependencies.graph.invoke).not.toHaveBeenCalled();
    expect(dependencies.lifecycle.fail).toHaveBeenCalledWith(JOB, "service_window_expired");
  });

  it("skips a legacy row with no encrypted reply target before invoking the graph", async () => {
    const dependencies = make_dependencies({
      record: { ...RECORD, reply_target_ciphertext: null },
    });
    const promise = process_job({
      job: JOB,
      inbound_loader: dependencies.loader,
      recipient_cipher: dependencies.recipient_cipher,
      calendar: dependencies.calendar,
      lifecycle: dependencies.lifecycle,
      graph_runner: dependencies.graph,
    });

    await expect(promise).rejects.toMatchObject({
      name: "JobProcessingError",
      code: "missing_reply_target",
      is_skipped: true,
    });
    expect(dependencies.lifecycle.fail).toHaveBeenCalledWith(JOB, "missing_reply_target");
    expect(dependencies.graph.invoke).not.toHaveBeenCalled();
    expect(dependencies.loader.mark_processed).not.toHaveBeenCalled();
  });

  it("fails before graph execution when the recipient cannot be authenticated", async () => {
    const dependencies = make_dependencies({
      recipient_cipher: new AesGcmRecipientCipher(Buffer.alloc(32, 10)),
    });
    const promise = process_job({
      job: JOB,
      inbound_loader: dependencies.loader,
      recipient_cipher: dependencies.recipient_cipher,
      calendar: dependencies.calendar,
      lifecycle: dependencies.lifecycle,
      graph_runner: dependencies.graph,
      max_attempts: 3,
    });

    await expect(promise).rejects.toMatchObject({
      name: "JobProcessingError",
      code: "reply_target_unavailable",
    });
    expect(dependencies.lifecycle.fail).toHaveBeenCalledWith(
      JOB,
      "reply_target_unavailable",
      expect.any(Date),
    );
    expect(dependencies.graph.invoke).not.toHaveBeenCalled();
    expect(dependencies.loader.mark_processed).not.toHaveBeenCalled();
  });

  it("schedules a bounded retry for a graph failure and stops after max attempts", async () => {
    const dependencies = make_dependencies({
      graph: { invoke: vi.fn(async () => { throw new Error("private graph detail"); }) },
    });
    const promise = process_job({
      job: JOB,
      inbound_loader: dependencies.loader,
      recipient_cipher: dependencies.recipient_cipher,
      calendar: dependencies.calendar,
      lifecycle: dependencies.lifecycle,
      graph_runner: dependencies.graph,
    });

    await expect(promise).rejects.toBeInstanceOf(JobProcessingError);
    expect(dependencies.lifecycle.fail).toHaveBeenCalledWith(
      JOB,
      "error",
      expect.any(Date),
    );

    const terminal_dependencies = make_dependencies({
      graph: { invoke: vi.fn(async () => { throw new Error("private graph detail"); }) },
    });
    await expect(
      process_job({
        job: { ...JOB, attempts: 3 },
        inbound_loader: terminal_dependencies.loader,
        recipient_cipher: terminal_dependencies.recipient_cipher,
        calendar: terminal_dependencies.calendar,
        lifecycle: terminal_dependencies.lifecycle,
        graph_runner: terminal_dependencies.graph,
        max_attempts: 3,
      }),
    ).rejects.toBeInstanceOf(JobProcessingError);
    expect(terminal_dependencies.lifecycle.fail).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: 3 }),
      "error",
      undefined,
    );
  });
});
