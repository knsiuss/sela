import { normalize_billing_tag } from "./billing.js";
import {
  derive_idempotency_key,
  fingerprint_outbound_message,
  IdempotencyCoordinator,
  IdempotencyError,
  type IdempotencyStore,
} from "./idempotency.js";
import {
  OutboundMessageValidationError,
  validate_outbound_message,
  type ConfirmationPolicy,
  type OutboundValidationOptions,
} from "./message_validation.js";
import {
  create_configuration_error,
  MetaGraphTransport,
  WhatsAppSendError,
  type WhatsAppTransport,
} from "./meta_transport.js";
import { TemplateRegistry, template_registry as default_template_registry } from "./template_registry.js";
import type { OutboundMessage, SendResult, TransportResponse, WaSendErrorCode } from "./types.js";

export {
  DEFAULT_META_REQUEST_TIMEOUT_MS,
  MAX_META_REQUEST_TIMEOUT_MS,
  MetaGraphTransport,
  WhatsAppSendError,
  parse_outbound_wamid,
} from "./meta_transport.js";
export type { MetaGraphTransportOptions, WhatsAppFetch, WhatsAppTransport } from "./meta_transport.js";
export { build_meta_payload, validate_outbound_message } from "./message_validation.js";
export type { ConfirmationPolicy, OutboundValidationOptions } from "./message_validation.js";

/** Constructor options for {@link WhatsAppSender}. */
export interface WhatsAppSenderOptions {
  /** Provider or test transport. */
  transport: WhatsAppTransport;
  /** Registry that controls approved utility templates. */
  template_registry?: TemplateRegistry;
  /** Force templates for all sends unless a stricter per-call flag is set. */
  template_required?: boolean;
  /** Explicit policy for state-changing messages. */
  confirmation_policy?: ConfirmationPolicy;
  /** Optional durable or test idempotency store. */
  idempotency_store?: IdempotencyStore<SendResult>;
  /** Optional preconfigured coordinator, primarily for embedding. */
  idempotency?: IdempotencyCoordinator<SendResult>;
  /** TTL for the default coordinator. */
  idempotency_ttl_ms?: number;
  /** Maximum entries for the default in-memory store. */
  idempotency_max_entries?: number;
}

/** Per-call policy settings; a configured constructor gate cannot be weakened. */
export interface WhatsAppSendOptions {
  /** Force a template for this call. */
  template_required?: boolean;
  /** Additional explicit confirmation policy for this call. */
  confirmation_policy?: ConfirmationPolicy;
}

/** Idempotent sender that applies validation and policy before transport I/O. */
export class WhatsAppSender {
  private readonly transport: WhatsAppTransport;
  private readonly template_registry: TemplateRegistry;
  private readonly template_required: boolean;
  private readonly confirmation_policy: ConfirmationPolicy | undefined;
  private readonly idempotency: IdempotencyCoordinator<SendResult>;

  /**
   * Create a sender from an options object or a transport plus options.
   *
   * @param transport_or_options - Transport or complete sender options.
   * @param options - Optional options when the first argument is a transport.
   * @throws WhatsAppSendError when sender configuration is invalid.
   */
  constructor(
    transport_or_options: WhatsAppTransport | WhatsAppSenderOptions,
    options: Omit<WhatsAppSenderOptions, "transport"> = {},
  ) {
    const settings = is_transport(transport_or_options)
      ? { ...options, transport: transport_or_options }
      : transport_or_options;
    if (!is_record(settings)) throw create_configuration_error("WhatsApp sender options are invalid");
    this.transport = require_transport(settings.transport);
    this.template_registry = settings.template_registry ?? default_template_registry;
    if (!(this.template_registry instanceof TemplateRegistry)) {
      throw create_configuration_error("template_registry is invalid");
    }
    validate_boolean_setting(settings.template_required, "template_required");
    this.template_required = settings.template_required ?? false;
    this.confirmation_policy = settings.confirmation_policy;
    this.idempotency = create_coordinator(settings);
  }

  /**
   * Validate, deduplicate, and send one message.
   *
   * @param message - Untrusted application message.
   * @param options - Optional per-call policy settings.
   * @returns The first successful or cached provider result.
   * @throws WhatsAppSendError for validation, policy, idempotency, or transport failures.
   */
  async send(message: OutboundMessage, options: WhatsAppSendOptions = {}): Promise<SendResult> {
    const validation_options: OutboundValidationOptions = {
      template_registry: this.template_registry,
      template_required: this.template_required || options.template_required === true,
      confirmation_policy: combine_policies(this.confirmation_policy, options.confirmation_policy),
    };
    validate_boolean_setting(options.template_required, "template_required");
    const validated = this.validate_message(message, validation_options);
    const key = this.derive_key(validated);
    let fingerprint: string;
    try {
      fingerprint = fingerprint_outbound_message(validated);
    } catch {
      throw new WhatsAppSendError("invalid_message", "idempotency", safe_error_message("invalid_message"));
    }
    try {
      return await this.idempotency.execute(key, fingerprint, async () => {
        const transport_message: OutboundMessage = { ...validated, idempotency_key: key };
        return this.submit(transport_message, key);
      });
    } catch (error) {
      throw map_send_error(error);
    }
  }

  private validate_message(message: OutboundMessage, options: OutboundValidationOptions): OutboundMessage {
    try {
      return validate_outbound_message(message, options);
    } catch (error) {
      if (error instanceof OutboundMessageValidationError) {
        throw new WhatsAppSendError(error.code, "validate", safe_error_message(error.code));
      }
      throw new WhatsAppSendError("invalid_message", "validate", "Outbound message could not be validated");
    }
  }

  private derive_key(message: OutboundMessage): string {
    try {
      return derive_idempotency_key(message);
    } catch {
      throw new WhatsAppSendError("invalid_message", "idempotency", safe_error_message("invalid_message"));
    }
  }

  private async submit(message: OutboundMessage, key: string): Promise<SendResult> {
    let response: TransportResponse;
    try {
      response = await this.transport.send(message);
    } catch (error) {
      if (error instanceof WhatsAppSendError) throw error;
      throw new WhatsAppSendError("transport_error", "transport", "WhatsApp transport failed");
    }
    const status = response.status ?? "sent";
    if (status !== "sent" && status !== "failed") {
      throw new WhatsAppSendError("invalid_response", "transport", "WhatsApp transport returned an invalid status");
    }
    if (status === "failed") {
      // A failed disposition is not a completed send and must remain retryable.
      throw new WhatsAppSendError("transport_error", "transport", "WhatsApp transport reported a failed send");
    }
    const wamid = require_wamid(response?.wamid);
    let billing = response.billing;
    if (billing !== undefined) {
      try {
        const normalized_billing = normalize_billing_tag(billing);
        if (normalized_billing === undefined) throw new Error("invalid billing");
        billing = normalized_billing;
      } catch {
        throw new WhatsAppSendError("invalid_response", "transport", "WhatsApp transport returned invalid billing");
      }
    }
    return { status, wamid, idempotency_key: key, ...(billing === undefined ? {} : { billing }) };
  }
}

function require_transport(value: unknown): WhatsAppTransport {
  if (!is_transport(value)) throw create_configuration_error("WhatsApp transport is required");
  return value;
}

function is_transport(value: unknown): value is WhatsAppTransport {
  return is_record(value) && typeof value.send === "function";
}

function create_coordinator(settings: WhatsAppSenderOptions): IdempotencyCoordinator<SendResult> {
  if (settings.idempotency !== undefined && settings.idempotency_store !== undefined) {
    throw create_configuration_error("Configure either idempotency or idempotency_store, not both");
  }
  if (settings.idempotency !== undefined) {
    if (!is_record(settings.idempotency) || typeof settings.idempotency.execute !== "function") {
      throw create_configuration_error("idempotency is invalid");
    }
    return settings.idempotency as IdempotencyCoordinator<SendResult>;
  }
  if (
    settings.idempotency_store !== undefined &&
    (!is_record(settings.idempotency_store) ||
      typeof settings.idempotency_store.get !== "function" ||
      typeof settings.idempotency_store.set !== "function")
  ) {
    throw create_configuration_error("idempotency_store is invalid");
  }
  return new IdempotencyCoordinator<SendResult>({
    store: settings.idempotency_store,
    ttl_ms: settings.idempotency_ttl_ms,
    max_entries: settings.idempotency_max_entries,
  });
}

function combine_policies(
  base_policy: ConfirmationPolicy | undefined,
  call_policy: ConfirmationPolicy | undefined,
): ConfirmationPolicy | undefined {
  if (base_policy === undefined) return call_policy;
  if (call_policy === undefined) return base_policy;
  return (message) => policy_allows(base_policy, message) && policy_allows(call_policy, message);
}

function policy_allows(policy: ConfirmationPolicy, message: OutboundMessage): boolean {
  try {
    return typeof policy === "function" ? policy(message) === true : policy.is_satisfied(message) === true;
  } catch {
    return false;
  }
}

function validate_boolean_setting(value: unknown, field_name: string): void {
  if (value !== undefined && typeof value !== "boolean") {
    throw create_configuration_error(`${field_name} is invalid`);
  }
}

function map_send_error(error: unknown): WhatsAppSendError {
  if (error instanceof WhatsAppSendError) return error;
  if (error instanceof IdempotencyError) {
    if (error.code === "conflict") {
      return new WhatsAppSendError("idempotency_conflict", "idempotency", safe_error_message("idempotency_conflict"));
    }
    if (error.code === "invalid_configuration") {
      return new WhatsAppSendError("configuration_error", "idempotency", safe_error_message("configuration_error"));
    }
    return new WhatsAppSendError("idempotency_unavailable", "idempotency", safe_error_message("idempotency_unavailable"));
  }
  if (error instanceof OutboundMessageValidationError) {
    return new WhatsAppSendError(error.code, "validate", safe_error_message(error.code));
  }
  return new WhatsAppSendError("transport_error", "send", "WhatsApp send failed");
}

function safe_error_message(code: WaSendErrorCode): string {
  const messages: Record<WaSendErrorCode, string> = {
    invalid_message: "Outbound message was invalid",
    template_not_registered: "Template is not registered",
    confirmation_required: "Explicit confirmation is required",
    template_required: "A registered template is required",
    configuration_error: "WhatsApp sender configuration was invalid",
    request_timeout: "WhatsApp request timed out",
    request_failed: "WhatsApp request failed before a response",
    upstream_error: "WhatsApp provider returned an error",
    invalid_response: "WhatsApp provider response was invalid",
    idempotency_conflict: "Idempotency key conflicts with an earlier request",
    idempotency_unavailable: "Idempotency state was unavailable",
    transport_error: "WhatsApp transport failed",
  };
  return messages[code];
}

function require_wamid(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new WhatsAppSendError("invalid_response", "transport", "WhatsApp transport returned an invalid message id");
  }
  return value;
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
