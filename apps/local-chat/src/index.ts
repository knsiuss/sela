/**
 * Entry point for the local end-user chat tool.
 *
 * Start it with `pnpm --filter @repo/local-chat start`, then open the printed
 * loopback URL. It boots the real appointment agent on a second loopback port
 * and serves the chat page that talks to it, so a human can hold a real
 * conversation without a Meta account.
 *
 * The app secret and verify token are generated here and never printed.
 */

import { start_local_agent } from "./agent_host.js";
import { start_chat_server } from "./chat_server.js";
import { build_synthetic_slots, create_local_credentials } from "./local_credentials.js";
import { ChatTurnGateway } from "./chat_turn.js";
import { LOOPBACK_HOST } from "./local_credentials.js";

/** Default agent ingress port; the operator dashboard keeps 3000. */
const AGENT_PORT = 3011;

/** Upper bound on the worker wait before the page is told no reply arrived. */
const REPLY_TIMEOUT_MS = 8_000;

async function main(): Promise<void> {
  const credentials = create_local_credentials();
  const slots = build_synthetic_slots(Date.now());
  const agent = await start_local_agent({
    agent_port: AGENT_PORT,
    credentials,
    slots,
  });
  const gateway = new ChatTurnGateway({
    agent_base_url: agent.base_url,
    webhook_path: agent.webhook_path,
    phone_number_id: agent.phone_number_id,
    recorder: agent.recorder,
    app_secret: credentials.app_secret,
    reply_timeout_ms: REPLY_TIMEOUT_MS,
  });
  const chat = await start_chat_server({
    gateway,
    webhook_path: agent.webhook_path,
    reply_timeout_ms: REPLY_TIMEOUT_MS,
    host: LOOPBACK_HOST,
    port: 3010,
  });
  console.info(JSON.stringify({ event: "local_chat_agent_started", webhook_path: agent.webhook_path }));
  console.info(JSON.stringify({
    event: "local_chat_ready",
    url: chat.base_url,
    agent_base_url: agent.base_url,
    credentials: "synthetic-in-memory",
  }));
  const shutdown = (): void => {
    void stop(agent.stop, chat.stop);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function stop(
  stop_agent: () => Promise<void>,
  stop_chat: () => Promise<void>,
): Promise<void> {
  try {
    await stop_agent();
    await stop_chat();
  } catch (error) {
    console.error(JSON.stringify({
      event: "local_chat_shutdown_failed",
      error_name: error instanceof Error ? error.name : "UnknownError",
    }));
  }
}

try {
  await main();
} catch (error) {
  // This line is for the operator's own terminal, not for a client, so the
  // sanitized reason is what makes a failed local start diagnosable.
  console.error(JSON.stringify({
    event: "local_chat_start_failed",
    error_name: error instanceof Error ? error.name : "UnknownError",
    error_message: error instanceof Error ? error.message : "unknown",
  }));
  process.exitCode = 1;
}
