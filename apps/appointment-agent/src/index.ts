import "dotenv/config";
import { InMemoryTenantAvailabilityProvider, SlotBroker } from "@repo/slot-broker";
import { SlotService } from "@repo/slot-engine";
import { build_graph } from "./graph.js";
import { cross_tenant_search_node, is_cross_tenant_search_message } from "./cross_tenant_search.js";
import { handle_voice_note } from "./voice_note_flow.js";
import type { TimeSlot } from "./state.js";
import { SlotServiceAdapter } from "./tools/slot_service_adapter.js";
import { start_all, start_worker_only, stop_all } from "./composition.js";

const DEFAULT_TENANT_ID = "default-tenant";
const DEFAULT_CROSS_TENANT_VERTICAL = "clinic";
const DEFAULT_CROSS_TENANT_LOCALE = "id-ID";
const CROSS_TENANT_SEARCH_WINDOW_DAYS = 7;
const MILLISECONDS_PER_DAY = 86_400_000;
type AppMode = "cli" | "server" | "worker";

function resolve_app_mode(env: Record<string, string | undefined>): AppMode {
  const mode = env["APP_MODE"] ?? "cli";
  if (mode !== "cli" && mode !== "server" && mode !== "worker") {
    throw new Error("APP_MODE must be server, worker, or cli");
  }
  return mode;
}

function make_default_slots(): TimeSlot[] {
  return [
    {
      id: "slot-1",
      start_iso: new Date(Date.now() + 86_400_000).toISOString(),
      end_iso: new Date(Date.now() + 90_000_000).toISOString(),
      staff: "provider_ani",
      resource: "dr. Ani",
    },
    {
      id: "slot-2",
      start_iso: new Date(Date.now() + 172_800_000).toISOString(),
      end_iso: new Date(Date.now() + 176_400_000).toISOString(),
      staff: "provider_budi",
      resource: "dr. Budi",
    },
  ];
}

async function run_server(): Promise<void> {
  await start_all();
  console.info(JSON.stringify({ event: "webhook_server_and_worker_started" }));
}

async function run_worker(): Promise<void> {
  await start_worker_only();
  console.info(JSON.stringify({ event: "webhook_worker_started" }));
}

async function run_cli(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<void> {
  const tenant_id = env["TENANT_ID"] ?? DEFAULT_TENANT_ID;
  // The CLI flag is a local scaffold switch, not a production authentication mechanism.
  const local_cross_tenant_authorizer = {
    can_search: () => env["CROSS_TENANT_AUTHZ_GRANTED"] === "true",
  };
  const is_voice_note_mode = args.includes("--voice-note");
  const message =
    args.find((argument) => argument !== "--voice-note") ??
    "I would like to reschedule to Thursday afternoon, can I?";
  const calendar = new SlotServiceAdapter({
    tenant_id,
    service: new SlotService(),
    slots: make_default_slots(),
  });

  if (is_voice_note_mode) {
    const result = handle_voice_note(message);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (is_cross_tenant_search_message(message)) {
    const search_start_ms = Date.now();
    const search_end_ms = search_start_ms + CROSS_TENANT_SEARCH_WINDOW_DAYS * MILLISECONDS_PER_DAY;
    const result = await cross_tenant_search_node(
      {
        intent: {
          requester_tenant_id: tenant_id,
          consent_granted: env["CROSS_TENANT_CONSENT_GRANTED"] === "true",
          vertical: env["CROSS_TENANT_VERTICAL"] ?? DEFAULT_CROSS_TENANT_VERTICAL,
          locale: env["CROSS_TENANT_LOCALE"] ?? DEFAULT_CROSS_TENANT_LOCALE,
          start_time: new Date(search_start_ms).toISOString(),
          end_time: new Date(search_end_ms).toISOString(),
        },
        user_message: message,
      },
      new SlotBroker(new InMemoryTenantAvailabilityProvider()),
      local_cross_tenant_authorizer,
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const app = build_graph(calendar);
  const result = await app.invoke({
    conversation_id: `cli-${Date.now()}`,
    raw_message: message,
    button_id: undefined,
    intent: "unknown",
    confidence: 0,
    candidate_slots: [],
    chosen_slot_id: undefined,
    hold: undefined,
    customer_confirmed: false,
    needs_human: false,
    human_summary: undefined,
    done: false,
  });
  console.log(JSON.stringify(result, null, 2));
}

const app_mode = resolve_app_mode(process.env);
if (app_mode === "server" || app_mode === "worker") {
  const shutdown = (): void => {
    void stop_all().catch((error: unknown) => {
      console.error(JSON.stringify({
        event: "shutdown_failed",
        error_name: error instanceof Error ? error.name : "UnknownError",
      }));
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  if (app_mode === "server") await run_server();
  else await run_worker();
} else {
  await run_cli(process.argv.slice(2), process.env);
}
