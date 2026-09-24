import "dotenv/config";
import { SlotService } from "@repo/slot-engine";
import { build_graph } from "./graph.js";
import type { TimeSlot } from "./state.js";
import { SlotServiceAdapter } from "./tools/slot_service_adapter.js";

const DEFAULT_TENANT_ID = "default-tenant";
const tenant_id = process.env.TENANT_ID ?? DEFAULT_TENANT_ID;
const slots: TimeSlot[] = [
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
const calendar = new SlotServiceAdapter({
  tenant_id,
  service: new SlotService(),
  slots,
});

const app = build_graph(calendar);
const message = process.argv[2] ?? "I would like to reschedule to Thursday afternoon, can I?";
const result = await app.invoke({
  conversation_id: `cli-${Date.now()}`,
  raw_message: message,
  intent: "unknown",
  confidence: 0,
  candidate_slots: [],
  chosen_slot_id: undefined,
  hold: undefined,
  needs_human: false,
  human_summary: undefined,
  done: false,
});
console.log(JSON.stringify(result, null, 2));
