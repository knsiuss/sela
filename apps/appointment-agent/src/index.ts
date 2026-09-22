import "dotenv/config";
import { build_graph } from "./graph.js";
import { InMemoryCalendar } from "./tools/calendar.js";

const calendar = new InMemoryCalendar([
  { id: "slot-1", start_iso: new Date(Date.now() + 86400000).toISOString(), end_iso: new Date(Date.now() + 90000000).toISOString(), staff: "dr. Ani" },
  { id: "slot-2", start_iso: new Date(Date.now() + 172800000).toISOString(), end_iso: new Date(Date.now() + 176400000).toISOString(), staff: "dr. Budi" },
]);

const app = build_graph(calendar);

const message = process.argv[2] ?? "mau geser ke kamis sore bisa?";
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
