/**
 * Synthetic, memory-only configuration for the local end-user chat tool.
 *
 * SECURITY: everything here is generated per process and never persisted. The
 * app secret exists so the tool can produce a genuine Meta HMAC signature; it
 * is deliberately not read from a file or the ambient environment, because a
 * dev tool that silently adopts a real `WHATSAPP_APP_SECRET` from the shell is
 * the exact pattern that leaks a real credential later. Nothing in this module
 * is ever logged or returned to the browser.
 */

import { randomBytes } from "node:crypto";
import type { TimeSlot } from "appointment-agent/dist/src/state.js";

/** Tenant the explicit in-memory sender and the single-tenant worker bind to. */
export const LOCAL_AGENT_TENANT_ID = "1";

/** Persona label shown by the shared local-only notice on the chat surface. */
export const LOCAL_END_USER_ROLE = "end user";

/** Only the loopback interface is a legal bind target for this tool. */
export const LOOPBACK_HOST = "127.0.0.1";

/**
 * Obvious non-production Meta phone number id.
 *
 * The in-memory tenant resolver maps exactly this id to
 * {@link LOCAL_AGENT_TENANT_ID}; any other channel account id stays unresolved
 * and is counted as `unresolved_count` without being queued, which is the
 * fail-closed behaviour worth keeping visible.
 */
export const LOCAL_SYNTHETIC_PHONE_NUMBER_ID = "155500000000001";

/** Secret length matching Meta's app-secret entropy guidance. */
const SECRET_BYTE_LENGTH = 32;

/** Worker poll cadence; a short interval keeps the local journey responsive. */
export const LOCAL_WORKER_POLL_INTERVAL_MS = 100;

const MILLISECONDS_PER_HOUR = 3_600_000;
const MILLISECONDS_PER_DAY = 86_400_000;
const SLOT_DURATION_MS = 30 * 60_000;

/** Credentials generated for one chat-tool process and never written down. */
export interface LocalCredentials {
  verify_token: string;
  app_secret: string;
  phone_number_id: string;
}

/** Sanitized failure for a chat-tool configuration that cannot be used safely. */
export class LocalChatConfigurationError extends Error {
  /** Create a safe configuration failure. */
  constructor(reason: string) {
    super(`local-chat-configuration-invalid: ${reason}`);
    this.name = "LocalChatConfigurationError";
  }
}

/**
 * Generate fresh synthetic webhook credentials for this process.
 *
 * @returns Random verify token and app secret plus the fixed channel id.
 */
export function create_local_credentials(): LocalCredentials {
  return {
    verify_token: randomBytes(SECRET_BYTE_LENGTH).toString("base64url"),
    app_secret: randomBytes(SECRET_BYTE_LENGTH).toString("base64url"),
    phone_number_id: LOCAL_SYNTHETIC_PHONE_NUMBER_ID,
  };
}

/**
 * Build the synthetic availability the agent offers during a local run.
 *
 * Slots sit one, two, and three days out so the graph's fourteen-day window
 * always contains them, and each carries a distinct `staff` provider id so the
 * slot service never treats two catalogue entries as one contended window.
 *
 * @param now_ms - Reference time; the first slot starts a day after it.
 * @returns Three validated-shape slots in chronological order.
 */
export function build_synthetic_slots(now_ms: number): TimeSlot[] {
  return [1, 2, 3].map((day) => {
    const start_ms = now_ms + day * MILLISECONDS_PER_DAY + 9 * MILLISECONDS_PER_HOUR;
    return {
      id: `local-slot-${day}`,
      start_iso: new Date(start_ms).toISOString(),
      end_iso: new Date(start_ms + SLOT_DURATION_MS).toISOString(),
      staff: `local-provider-${day}`,
      resource: `Room ${day}`,
    };
  });
}

/** Inputs for the agent environment the chat tool boots. */
export interface LocalAgentEnvInput {
  agent_port: number;
  credentials: LocalCredentials;
  slots: readonly TimeSlot[];
  poll_interval_ms?: number;
}

/**
 * Build the environment for the real in-memory agent composition.
 *
 * This is the documented `APP_MODE=server` / `USE_IN_MEMORY=true` /
 * `WHATSAPP_TRANSPORT=memory` local shape from `apps/appointment-agent`. It
 * deliberately omits `DATABASE_URL` and `TENANT_ID`: the composition rejects
 * the two persistence settings together, and leaving `TENANT_ID` unset is what
 * binds the non-network sender and the worker to tenant `1`.
 *
 * @param input - Port, credentials, and the synthetic slot catalogue.
 * @returns An environment mapping safe to hand to `build_composition`.
 * @throws LocalChatConfigurationError When a required value is unusable.
 */
export function build_local_agent_env(input: LocalAgentEnvInput): Record<string, string> {
  const port = require_port(input.agent_port);
  const poll_interval_ms = require_poll_interval(input.poll_interval_ms ?? LOCAL_WORKER_POLL_INTERVAL_MS);
  if (input.credentials.app_secret === "" || input.credentials.verify_token === "") {
    throw new LocalChatConfigurationError("credentials-missing");
  }
  if (input.slots.length === 0) throw new LocalChatConfigurationError("slots-required");
  const env: Record<string, string> = {
    APP_MODE: "server",
    USE_IN_MEMORY: "true",
    WHATSAPP_TRANSPORT: "memory",
    HOST: LOOPBACK_HOST,
    PORT: String(port),
    TENANT_ID: LOCAL_AGENT_TENANT_ID,
    WHATSAPP_VERIFY_TOKEN: input.credentials.verify_token,
    WHATSAPP_APP_SECRET: input.credentials.app_secret,
    WHATSAPP_PHONE_NUMBER_ID: input.credentials.phone_number_id,
    CALENDAR_SLOTS_JSON: JSON.stringify(input.slots),
    WORKER_POLL_INTERVAL_MS: String(poll_interval_ms),
  };
  assert_in_memory_pairing(env);
  return env;
}

/**
 * Reject an environment that pairs a non-network transport with real
 * persistence, or that lets the agent bind a non-loopback interface.
 *
 * @param env - Candidate agent environment.
 * @throws LocalChatConfigurationError When the pairing or host is unsafe.
 */
export function assert_in_memory_pairing(env: Readonly<Record<string, string>>): void {
  const has_database = (env["DATABASE_URL"] ?? "").trim() !== "";
  if (has_database) throw new LocalChatConfigurationError("database-and-in-memory-are-mutually-exclusive");
  if (env["USE_IN_MEMORY"] !== "true") throw new LocalChatConfigurationError("use-in-memory-required");
  if (env["WHATSAPP_TRANSPORT"] !== "memory") throw new LocalChatConfigurationError("memory-transport-required");
  if (env["HOST"] !== LOOPBACK_HOST) throw new LocalChatConfigurationError("loopback-host-required");
}

function require_port(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new LocalChatConfigurationError("agent-port-invalid");
  }
  return value;
}

function require_poll_interval(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 60_000) {
    throw new LocalChatConfigurationError("worker-poll-interval-invalid");
  }
  return value;
}
