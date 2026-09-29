/** Provider-shaped fixtures for the offline Meta integration gate. */

import { createHmac } from "node:crypto";

/** App secret used only for offline fixture signatures; never a credential. */
export const FIXTURE_APP_SECRET = "fixture-app-secret-not-a-credential";

/** Synthetic sender in the reserved test range; never a real recipient. */
export const FIXTURE_SENDER = "+15550001111";

/** Synthetic channel account used by offline fixtures. */
export const FIXTURE_PHONE_NUMBER_ID = "100000000000001";

/** Delivery status values Meta reports on the statuses webhook. */
export type FixtureDeliveryStatus = "sent" | "delivered" | "read" | "failed";

/** Optional overrides for an inbound fixture body. */
export interface InboundFixtureInput {
  wamid?: string;
  from?: string;
  body?: string;
  phone_number_id?: string;
  timestamp?: string;
}

/** Optional overrides for a button fixture body. */
export interface ButtonFixtureInput extends InboundFixtureInput {
  payload?: string;
  text?: string;
}

/** Optional overrides for an interactive reply fixture body. */
export interface InteractiveFixtureInput extends InboundFixtureInput {
  button_id?: string;
  title?: string;
}

/** Required fields for a delivery-status fixture body. */
export interface StatusFixtureInput {
  provider_message_id: string;
  status: FixtureDeliveryStatus;
  phone_number_id?: string;
  timestamp?: string;
  error_code?: string | number;
}

/**
 * Build a live-shaped inbound text webhook body.
 *
 * @param input - Optional wamid, sender, body, channel, and timestamp overrides.
 * @returns JSON webhook body matching the Meta messages shape.
 */
export function build_text_webhook(input: InboundFixtureInput = {}): string {
  return JSON.stringify(fixture_envelope({
    phone_number_id: input.phone_number_id ?? FIXTURE_PHONE_NUMBER_ID,
    messages: [{
      from: input.from ?? FIXTURE_SENDER.replace("+", ""),
      id: input.wamid ?? "wamid.fixture.text.1",
      timestamp: input.timestamp ?? "1780000000",
      type: "text",
      text: { body: input.body ?? "I want to reschedule my appointment" },
    }],
  }));
}

/**
 * Build a live-shaped legacy button webhook body.
 *
 * @param input - Optional wamid, sender, payload, label, and channel overrides.
 * @returns JSON webhook body with a type button node.
 */
export function build_legacy_button_webhook(input: ButtonFixtureInput = {}): string {
  return JSON.stringify(fixture_envelope({
    phone_number_id: input.phone_number_id ?? FIXTURE_PHONE_NUMBER_ID,
    messages: [{
      from: input.from ?? FIXTURE_SENDER.replace("+", ""),
      id: input.wamid ?? "wamid.fixture.button.1",
      timestamp: input.timestamp ?? "1780000100",
      type: "button",
      button: {
        payload: input.payload ?? "pick_slot_1",
        text: input.text ?? input.body ?? "Pick slot 1",
      },
    }],
  }));
}

/**
 * Build a live-shaped interactive button-reply webhook body.
 *
 * @param input - Optional wamid, sender, reply id, title, and channel overrides.
 * @returns JSON webhook body with an interactive button_reply node.
 */
export function build_interactive_reply_webhook(input: InteractiveFixtureInput = {}): string {
  return JSON.stringify(fixture_envelope({
    phone_number_id: input.phone_number_id ?? FIXTURE_PHONE_NUMBER_ID,
    messages: [{
      from: input.from ?? FIXTURE_SENDER.replace("+", ""),
      id: input.wamid ?? "wamid.fixture.interactive.1",
      timestamp: input.timestamp ?? "1780000200",
      type: "interactive",
      interactive: {
        type: "button_reply",
        button_reply: {
          id: input.button_id ?? "confirm_move",
          title: input.title ?? input.body ?? "Confirm move",
        },
      },
    }],
  }));
}

/**
 * Build a live-shaped handoff webhook body for the operator keyword.
 *
 * @param input - Optional sender and channel overrides.
 * @returns JSON webhook body whose text requests a human operator.
 */
export function build_handoff_webhook(input: InboundFixtureInput = {}): string {
  return build_text_webhook({
    ...input,
    wamid: input.wamid ?? "wamid.fixture.handoff.1",
    body: "Please connect me to an operator",
  });
}

/**
 * Build a live-shaped delivery-status webhook body.
 *
 * @param input - Provider message id, status, channel, and error overrides.
 * @returns JSON webhook body matching the Meta statuses shape.
 */
export function build_status_webhook(input: StatusFixtureInput): string {
  const status_node: Record<string, unknown> = {
    id: input.provider_message_id,
    status: input.status,
    timestamp: input.timestamp ?? "1780000300",
  };
  if (input.status === "failed") {
    status_node["errors"] = [{ code: input.error_code ?? 131047, title: "Re-engagement required" }];
  } else if (input.error_code !== undefined) {
    status_node["errors"] = [{ code: input.error_code }];
  }
  return JSON.stringify(fixture_envelope({
    phone_number_id: input.phone_number_id ?? FIXTURE_PHONE_NUMBER_ID,
    statuses: [status_node],
  }));
}

/**
 * Build a live-shaped successful send response payload.
 *
 * @param wamid - Provider message id to echo back.
 * @returns Response payload matching the Meta messages response shape.
 */
export function build_send_success_response(wamid: string): unknown {
  return { messages: [{ id: wamid }] };
}

/**
 * Build a live-shaped provider error response payload.
 *
 * @param input - HTTP status, Meta error code, message, and optional subcode.
 * @returns Response payload matching the Meta error shape.
 */
export function build_send_error_response(input: {
  http_status: number;
  code: string | number;
  message: string;
  error_subcode?: string | number;
}): unknown {
  return {
    http_status: input.http_status,
    error: {
      message: input.message,
      code: input.code,
      ...(input.error_subcode === undefined ? {} : { error_subcode: input.error_subcode }),
    },
  };
}

/**
 * Sign a fixture body the way Meta signs webhook deliveries.
 *
 * @param body - Exact raw fixture bytes to sign.
 * @param app_secret - App secret used for the HMAC digest.
 * @returns Value for the X-Hub-Signature-256 header.
 */
export function sign_fixture(body: string, app_secret: string): string {
  return `sha256=${createHmac("sha256", app_secret).update(body).digest("hex")}`;
}

function fixture_envelope(input: {
  phone_number_id: string;
  messages?: unknown[];
  statuses?: unknown[];
}): unknown {
  const value: Record<string, unknown> = {
    messaging_product: "whatsapp",
    metadata: { phone_number_id: input.phone_number_id },
    phone_number_id: input.phone_number_id,
  };
  if (input.messages !== undefined) value["messages"] = input.messages;
  if (input.statuses !== undefined) value["statuses"] = input.statuses;
  if (input.messages !== undefined) {
    value["contacts"] = [{ wa_id: FIXTURE_SENDER.replace("+", "") }];
  }
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "0", changes: [{ field: "messages", value }] }],
  };
}
