/** Durable, tenant-aware wrapper around the provider sender boundary. */

import type { OutboundDraft } from "../worker/process_job.js";
import {
  consume_or_throw,
  RateLimitExceededError,
  type TenantRateLimiter,
} from "../rate_limit/tenant_rate_limiter.js";
import type { MetricsSink } from "../observability/metrics.js";
import type { OutboundSenderRegistry } from "../worker/loop.js";
import {
  derive_outbound_operation_key,
  OutboundLedgerError,
  OutboundLedgerUnknownError,
  outbound_request_fingerprint,
  type OutboundLedgerStore,
} from "./outbound_ledger.js";

/** Configuration for one durable outbound registry. */
export interface DurableOutboundRegistryOptions {
  registry: OutboundSenderRegistry;
  ledger: OutboundLedgerStore;
  provider: string;
  rate_limiter?: TenantRateLimiter;
  outbound_limit?: number;
  outbound_window_seconds?: number;
  /** Explicit local/test mode only; production never enables synthetic provider ids. */
  allow_synthetic_ack?: boolean;
  metrics?: MetricsSink;
}

/** Safe acknowledgement returned after a durable send or replay. */
export interface DurableSendResult {
  status: "sent";
  wamid: string;
  replayed: boolean;
}

/** Sender registry that makes provider calls restart-safe and tenant-scoped. */
export class DurableOutboundSenderRegistry implements OutboundSenderRegistry {
  private readonly registry: OutboundSenderRegistry;
  private readonly ledger: OutboundLedgerStore;
  private readonly provider: string;
  private readonly rate_limiter: TenantRateLimiter | undefined;
  private readonly outbound_limit: number;
  private readonly outbound_window_seconds: number;
  private readonly allow_synthetic_ack: boolean;
  private readonly metrics: MetricsSink | undefined;

  /** Create a wrapper around an explicitly resolved provider registry. */
  constructor(options: DurableOutboundRegistryOptions) {
    this.registry = options.registry;
    this.ledger = options.ledger;
    this.provider = valid_provider(options.provider);
    this.rate_limiter = options.rate_limiter;
    this.outbound_limit = bounded_integer(options.outbound_limit ?? 60, "outbound_limit", 100_000);
    this.outbound_window_seconds = bounded_integer(
      options.outbound_window_seconds ?? 60,
      "outbound_window_seconds",
      86_400,
    );
    this.allow_synthetic_ack = options.allow_synthetic_ack === true;
    this.metrics = options.metrics;
  }

  /** Claim, rate-limit, send, and commit one draft in that order. */
  async send(tenant_id: string, draft: OutboundDraft): Promise<DurableSendResult> {
    const tenant = valid_tenant(tenant_id);
    const operation_key = derive_outbound_operation_key(tenant, draft);
    const request_fingerprint = outbound_request_fingerprint(tenant, this.provider, operation_key, draft);
    const claim = await this.ledger.begin({
      tenant_id: tenant,
      provider: this.provider,
      operation_key,
      request_fingerprint,
      inbound_wamid: draft.inbound_wamid,
      turn_id: draft.turn_id,
      lease_seconds: 30,
    });
    if (claim.kind === "replay") return replay_result(claim.record.status, claim.record.provider_message_id);

    if (this.rate_limiter !== undefined) {
      try {
        await consume_or_throw(this.rate_limiter, {
          tenant_id: tenant,
          scope: "outbound",
          limit: this.outbound_limit,
          window_seconds: this.outbound_window_seconds,
        });
      } catch (error) {
        if (error instanceof RateLimitExceededError) {
          try {
            await this.ledger.mark_failed({
              tenant_id: tenant,
              provider: this.provider,
              operation_key,
              lease_token: claim.lease_token,
              error_code: "rate_limited",
              retryable: true,
              next_attempt_at: error.retry_at.toISOString(),
            });
          } catch (ledger_error) {
            throw new OutboundLedgerError(
              "outbound_rate_limit_persist_failed",
              "outbound-rate-limit-unrecorded",
              new AggregateError([error, ledger_error], "outbound-rate-limit-unrecorded"),
            );
          }
        } else {
          try {
            await this.ledger.mark_failed({
              tenant_id: tenant,
              provider: this.provider,
              operation_key,
              lease_token: claim.lease_token,
              error_code: "rate_limiter_unavailable",
              retryable: true,
            });
          } catch {
            // The original limiter failure remains the actionable error; the lease
            // will become unknown rather than permitting an unsafe duplicate send.
          }
        }
        throw error;
      }
    }

    let provider_result: unknown;
    try {
      provider_result = await this.registry.send(tenant, draft);
    } catch (error) {
      await this.handle_send_error(tenant, operation_key, claim.lease_token, error);
      throw error;
    }

    let wamid: string;
    try {
      wamid = extract_wamid(provider_result, this.allow_synthetic_ack, operation_key);
      await this.ledger.mark_sent({
        tenant_id: tenant,
        provider: this.provider,
        operation_key,
        lease_token: claim.lease_token,
        provider_message_id: wamid,
        provider_status_code: extract_status_code(provider_result),
      });
    } catch (error) {
      if (error instanceof OutboundLedgerError && error.code === "outbound_provider_ack_invalid") {
        await this.handle_send_error(tenant, operation_key, claim.lease_token, error);
      }
      throw error;
    }
    this.metrics?.increment("outbound_provider_sends_total", { provider: this.provider, result: "sent" });
    return { status: "sent", wamid, replayed: false };
  }

  private async handle_send_error(
    tenant_id: string,
    operation_key: string,
    lease_token: string,
    error: unknown,
  ): Promise<void> {
    const code = safe_error_code(error);
    if (is_ambiguous_error(error)) {
      try {
        await this.ledger.mark_unknown({
          tenant_id,
          provider: this.provider,
          operation_key,
          lease_token,
          error_code: code,
        });
        this.metrics?.increment("outbound_provider_sends_total", { provider: this.provider, result: "unknown" });
      } catch (ledger_error) {
        throw new OutboundLedgerError(
          "outbound_unknown_persist_failed",
          "outbound-provider-result-unrecorded",
          new AggregateError([error, ledger_error], "outbound-provider-result-unrecorded"),
        );
      }
      return;
    }
    try {
      await this.ledger.mark_failed({
        tenant_id,
        provider: this.provider,
        operation_key,
        lease_token,
        error_code: code,
        retryable: false,
      });
      this.metrics?.increment("outbound_provider_sends_total", { provider: this.provider, result: "failed" });
    } catch (ledger_error) {
      throw new OutboundLedgerError(
        "outbound_failure_persist_failed",
        "outbound-provider-failure-unrecorded",
        new AggregateError([error, ledger_error], "outbound-provider-failure-unrecorded"),
      );
    }
  }
}

function replay_result(status: string, provider_message_id: string | null): DurableSendResult {
  if (status === "failed") throw new OutboundLedgerError("outbound_terminal", "outbound-operation-terminal");
  if (status === "unknown") throw new OutboundLedgerUnknownError();
  if (provider_message_id === null) throw new OutboundLedgerError("outbound_replay_result_invalid");
  return { status: "sent", wamid: provider_message_id, replayed: true };
}

function extract_wamid(value: unknown, allow_synthetic_ack: boolean, operation_key: string): string {
  if (
    allow_synthetic_ack
    && (!is_record(value) || value.status !== "sent" || typeof value.wamid !== "string")
    && !(is_record(value) && value.status === "failed")
  ) {
    return `local:${operation_key.slice(0, 48)}`;
  }
  if (!is_record(value) || value.status !== "sent" || typeof value.wamid !== "string") {
    throw new OutboundLedgerError("outbound_provider_ack_invalid", "outbound-provider-ack-invalid");
  }
  if (
    value.wamid.length < 1
    || value.wamid.length > 256
    || value.wamid.trim() !== value.wamid
    || /[\u0000-\u001f\u007f]/u.test(value.wamid)
  ) {
    throw new OutboundLedgerError("outbound_provider_ack_invalid", "outbound-provider-ack-invalid");
  }
  return value.wamid;
}

function extract_status_code(value: unknown): string | undefined {
  if (!is_record(value)) return undefined;
  const code = value.upstream_code ?? value.code_upstream;
  if (typeof code === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(code)) return code;
  return undefined;
}

function safe_error_code(error: unknown): string {
  if (is_record(error) && typeof error.code === "string") {
    const normalized = error.code.toLowerCase().replace(/[^a-z0-9_]+/gu, "_");
    if (/^[a-z0-9_]{1,64}$/.test(normalized)) return normalized;
  }
  if (error instanceof Error) {
    const normalized = error.name.toLowerCase().replace(/[^a-z0-9_]+/gu, "_");
    if (/^[a-z0-9_]{1,64}$/.test(normalized)) return normalized;
  }
  return "outbound_send_failed";
}

function is_ambiguous_error(error: unknown): boolean {
  if (!is_record(error) || typeof error.code !== "string") return false;
  return ["request_timeout", "request_failed", "transport_error", "upstream_error"].includes(error.code);
}

function valid_provider(value: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) {
    throw new OutboundLedgerError("outbound_provider_invalid");
  }
  return value;
}

function valid_tenant(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new OutboundLedgerError("outbound_tenant_invalid");
  }
  return value;
}

function bounded_integer(value: number, field_name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${field_name}-invalid`);
  }
  return value;
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
