import type { OutboundMessage } from "./types.js";

/** Stable validation failures that never contain message content. */
export type OutboundValidationCode =
  | "invalid_message"
  | "template_not_registered"
  | "confirmation_required"
  | "template_required"
  | "configuration_error";

/** Safe domain error raised before a message reaches a transport. */
export class OutboundMessageValidationError extends Error {
  /** Machine-readable reason safe for logs and callers. */
  readonly code: OutboundValidationCode;

  /**
   * Create a safe message validation error.
   *
   * @param code - Stable reason without recipient or content.
   */
  constructor(code: OutboundValidationCode) {
    super(`outbound-message-invalid: ${code}`);
    this.name = "OutboundMessageValidationError";
    this.code = code;
  }
}

/** Callback or policy object that proves a state-changing send is allowed. */
export type ConfirmationPolicy =
  | ((message: OutboundMessage) => boolean)
  | {
      is_satisfied(message: OutboundMessage): boolean;
    };
