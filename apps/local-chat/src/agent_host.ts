/**
 * Boots the real appointment agent for the local chat tool.
 *
 * The tool deliberately runs the agent through its own documented composition
 * root rather than a bespoke harness: `build_composition` supplies the real
 * ingress stores, queue, worker, turn processor, calendar, durable outbound
 * ledger, and the `RescheduleTurnProcessor` state machine. The only thing
 * replaced is the sender registry, and only so the tool can observe what the
 * real sender actually sent.
 *
 * SECURITY: the agent binds `127.0.0.1` from the environment this module
 * builds. Nothing here widens the bind, weakens signature verification, or
 * changes any fail-closed rule; `apps/appointment-agent` has no source change
 * at all.
 */

import { build_composition, type AppComposition } from "appointment-agent/dist/src/composition.js";
import { build_runtime_sender } from "appointment-agent/dist/src/outbound/runtime_sender.js";
import { HEALTH_PATH, WEBHOOK_PATH } from "appointment-agent/dist/src/http/server.js";
import type { TimeSlot } from "appointment-agent/dist/src/state.js";
import { LocalChatOutboundRecorder } from "./outbound_recorder.js";
import {
  build_local_agent_env,
  LOOPBACK_HOST,
  type LocalCredentials,
} from "./local_credentials.js";

/** Bounded readiness probe so start-up cannot hang on a dead agent. */
const HEALTH_PROBE_ATTEMPTS = 40;
const HEALTH_PROBE_INTERVAL_MS = 250;
const HEALTH_PROBE_TIMEOUT_MS = 1_000;

/** A running agent plus the recorder that observed its outbound traffic. */
export interface LocalAgentHost {
  composition: AppComposition;
  recorder: LocalChatOutboundRecorder;
  base_url: string;
  webhook_path: string;
  phone_number_id: string;
  stop(): Promise<void>;
}

/** Inputs for one local agent process. */
export interface StartLocalAgentInput {
  agent_port: number;
  credentials: LocalCredentials;
  slots: readonly TimeSlot[];
  poll_interval_ms?: number;
}

/**
 * Start the real in-memory agent and return the loopback base URL to talk to.
 *
 * @param input - Port, generated credentials, and the synthetic slot catalogue.
 * @returns The running composition, its recorder, and the ingress address.
 * @throws When the composition refuses the environment or cannot bind.
 */
export async function start_local_agent(input: StartLocalAgentInput): Promise<LocalAgentHost> {
  const env = build_local_agent_env({
    agent_port: input.agent_port,
    credentials: input.credentials,
    slots: input.slots,
    ...(input.poll_interval_ms === undefined ? {} : { poll_interval_ms: input.poll_interval_ms }),
  });
  // `build_runtime_sender` honours WHATSAPP_TRANSPORT=memory, so the sender
  // underneath the recorder is the same non-network sender the documented
  // local run uses. Wrapping it adds observation, not a different sender.
  const recorder = new LocalChatOutboundRecorder(build_runtime_sender(env));
  const composition = build_composition({ env, sender_registry: recorder });
  await composition.start();
  // The composition deliberately does not expose its listening server, so the
  // port is the one this tool configured, and readiness is proven with the
  // agent's own health probe instead of being assumed.
  const base_url = `http://${LOOPBACK_HOST}:${input.agent_port}`;
  await wait_until_healthy(`${base_url}${HEALTH_PATH}`);
  return {
    composition,
    recorder,
    base_url,
    webhook_path: WEBHOOK_PATH,
    phone_number_id: input.credentials.phone_number_id,
    stop: () => composition.stop(),
  };
}

/**
 * Block until the agent answers its own health probe.
 *
 * Failing here rather than serving a chat page that cannot reach the agent
 * keeps the tool's start-up honest about what is actually running.
 *
 * @param health_url - Loopback health endpoint of the started agent.
 * @throws When the agent does not answer within the bounded wait.
 */
async function wait_until_healthy(health_url: string): Promise<void> {
  for (let attempt = 0; attempt < HEALTH_PROBE_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(health_url, { signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS) });
      if (response.ok) return;
    } catch {
      // Not listening yet; the bounded loop below owns the retry.
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_PROBE_INTERVAL_MS));
  }
  throw new Error("local-chat-agent-not-healthy");
}
