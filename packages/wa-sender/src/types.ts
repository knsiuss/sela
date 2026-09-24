/** Public contracts for idempotent WhatsApp outbound messaging. */

/** Meta template categories that can affect pricing and compliance. */
export type TemplateCategory = "marketing" | "utility" | "authentication";

/** Transport-level outcome of a send request. */
export type SendStatus = "sent" | "failed";

/** Delivery states reported by WhatsApp status webhooks. */
export type DeliveryStatus = "sent" | "delivered" | "read" | "failed";

/** Timestamp inputs accepted by the pure service-window helpers. */
export type TimestampInput = number | string | Date;

/** A value accepted by a WhatsApp template component. */
export interface TemplateParameter {
  /** Meta parameter type, such as text or payload. */
  type: string;
  /** Text value for a text parameter. */
  text?: string;
  /** Opaque quick-reply value for a payload parameter. */
  payload?: string;
  /** URL value for a URL parameter. */
  url?: string;
  /** Allow forward-compatible Meta fields without weakening the required type. */
  [key: string]: unknown;
}

/** A body or button component in a template request. */
export interface TemplateComponent {
  /** Meta component type, such as body or button. */
  type: string;
  /** Button subtype, such as quick_reply. */
  sub_type?: string;
  /** Button index within the template. */
  index?: string | number;
  /** Values inserted into the component. */
  parameters?: readonly TemplateParameter[];
  /** Allow forward-compatible Meta fields. */
  [key: string]: unknown;
}

/** Template fields sent to the Meta Graph messages endpoint. */
export interface TemplatePayload {
  /** Registered template name. */
  name: string;
  /** ISO language code or Meta language object. */
  language: string | { code: string; [key: string]: unknown };
  /** Optional body and button components. */
  components?: readonly TemplateComponent[];
}

/** Interactive reply-button payload for a service-window message. */
export interface InteractivePayload {
  /** Meta interactive type; only reply buttons are supported by this boundary. */
  type: "button";
  /** Visible message body. */
  body: { text: string; preview_url?: boolean };
  /** Deterministic quick-reply actions. */
  action: { buttons: readonly OutboundButton[] };
}

/** A deterministic quick-reply or URL action attached to an outbound draft. */
export interface OutboundButton {
  /** Stable application button identifier. */
  button_id: string;
  /** User-visible label, limited by the template registry policy. */
  label: string;
  /** Button behavior; quick replies are the default for consent actions. */
  type?: "quick_reply" | "url";
  /** Opaque payload for a quick reply. */
  payload?: string;
  /** Destination for a URL button. */
  url?: string;
}

/**
 * One outbound WhatsApp message before transport submission.
 *
 * `idempotency_key` is optional at this boundary so the sender can derive it
 * from an inbound WAMID and turn, or from a content hash. A template message
 * must name a registry entry; the sender rejects unregistered templates.
 */
export interface OutboundMessage {
  /** Recipient in international phone format. */
  to: string;
  /** WhatsApp message type. */
  type: "text" | "template" | "interactive";
  /** Text payload for a free-form message. */
  text?: { body: string; preview_url?: boolean };
  /** Template payload for a registered template. */
  template?: TemplatePayload;
  /** Application-level buttons converted to template components. */
  buttons?: readonly OutboundButton[];
  /** Interactive reply-button payload for a service-window message. */
  interactive?: InteractivePayload;
  /** Stable key for one logical outbound operation. */
  idempotency_key?: string;
  /** Stable inbound WAMID used to derive a key when turn_id is available. */
  inbound_wamid?: string;
  /** Stable turn identifier used to distinguish multiple replies. */
  turn_id?: string;
  /** Require an approved template for this send, regardless of the service window. */
  template_required?: boolean;
  /** Mark a message as state-changing even when the caller uses a named gate. */
  is_state_changing?: boolean;
  /** Explicit user-consent gate for state-changing confirmation messages. */
  requires_confirmation?: boolean;
}

/** Normalized response returned by a WhatsApp transport. */
export interface TransportResponse {
  /** Outbound WhatsApp message identifier. */
  wamid: string;
  /** Optional transport disposition when an adapter can reject without throwing. */
  status?: SendStatus;
  /** Optional pricing metadata returned by an adapter or test double. */
  billing?: BillingTag;
}

/** Result of one idempotent sender operation. */
export interface SendResult {
  /** Transport disposition. */
  status: SendStatus;
  /** Outbound WhatsApp message identifier returned by Meta. */
  wamid: string;
  /** Key used to suppress duplicate sends. */
  idempotency_key: string;
  /** Pricing tag when the transport supplied one. */
  billing?: BillingTag;
}

/** Delivery and pricing data received from a status webhook. */
export interface DeliveryReceipt {
  /** Outbound WhatsApp message identifier. */
  wamid: string;
  /** Meta delivery state. */
  status: DeliveryStatus;
  /** Webhook timestamp in ISO format when available. */
  occurred_at_iso?: string;
  /** Pricing tag attached to the delivery event. */
  billing?: BillingTag;
  /** Safe provider error code when the delivery failed. */
  error_code?: string;
}

/** Pricing fields used for cost metrics without copying provider response bodies. */
export interface BillingTag {
  /** Whether Meta marks the event billable. */
  billable: boolean;
  /** Meta pricing model identifier. */
  pricing_model: string;
  /** Category used for pricing. */
  category: TemplateCategory;
  /** Message type used for pricing. */
  type: string;
}

/** Stable error categories exposed by the WhatsApp sender boundary. */
export type WaSendErrorCode =
  | "invalid_message"
  | "template_not_registered"
  | "confirmation_required"
  | "template_required"
  | "configuration_error"
  | "request_timeout"
  | "request_failed"
  | "upstream_error"
  | "invalid_response"
  | "idempotency_conflict"
  | "idempotency_unavailable"
  | "transport_error";
