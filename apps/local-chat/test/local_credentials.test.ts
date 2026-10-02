/**
 * The local environment must stay the documented in-memory shape.
 *
 * These assertions are a security boundary, not a convenience check: the tool
 * only earns the right to hold an app secret because it cannot be pointed at
 * real persistence or a real network bind.
 */

import { describe, expect, it } from "vitest";
import { time_slot_schema } from "appointment-agent/dist/src/calendar/calendar_models.js";
import {
  assert_in_memory_pairing,
  build_local_agent_env,
  build_synthetic_slots,
  create_local_credentials,
  LOOPBACK_HOST,
  LocalChatConfigurationError,
  LOCAL_SYNTHETIC_PHONE_NUMBER_ID,
} from "../src/local_credentials.js";

const CREDENTIALS = create_local_credentials();
const SLOTS = build_synthetic_slots(Date.parse("2026-10-02T00:00:00.000Z"));

function env(): Record<string, string> {
  return build_local_agent_env({ agent_port: 3011, credentials: CREDENTIALS, slots: SLOTS });
}

describe("local agent environment", () => {
  it("selects the documented in-memory server composition", () => {
    expect(env()).toMatchObject({
      APP_MODE: "server",
      USE_IN_MEMORY: "true",
      WHATSAPP_TRANSPORT: "memory",
      HOST: LOOPBACK_HOST,
      PORT: "3011",
      TENANT_ID: "1",
    });
  });

  it("never configures real persistence alongside the memory transport", () => {
    const built = env();
    expect(built["DATABASE_URL"]).toBeUndefined();
    expect(built["WHATSAPP_API_TOKEN"]).toBeUndefined();
    expect(built["WHATSAPP_GRAPH_API_URL"]).toBeUndefined();
  });

  it("registers the synthetic channel account the tenant resolver knows", () => {
    expect(env()["WHATSAPP_PHONE_NUMBER_ID"]).toBe(LOCAL_SYNTHETIC_PHONE_NUMBER_ID);
  });

  it("refuses a port the operating system cannot bind", () => {
    expect(() => build_local_agent_env({ agent_port: 0, credentials: CREDENTIALS, slots: SLOTS }))
      .toThrow(LocalChatConfigurationError);
  });

  it("refuses an empty catalogue so the agent has nothing to offer", () => {
    expect(() => build_local_agent_env({ agent_port: 3011, credentials: CREDENTIALS, slots: [] }))
      .toThrow(LocalChatConfigurationError);
  });
});

describe("in-memory pairing", () => {
  it("accepts the environment this tool builds", () => {
    expect(() => assert_in_memory_pairing(env())).not.toThrow();
  });

  it("rejects a database-backed environment", () => {
    expect(() => assert_in_memory_pairing({ ...env(), DATABASE_URL: "postgresql://x/y" }))
      .toThrow(/mutually-exclusive/u);
  });

  it("rejects a non-memory transport", () => {
    expect(() => assert_in_memory_pairing({ ...env(), WHATSAPP_TRANSPORT: "meta" }))
      .toThrow(/memory-transport-required/u);
  });

  it("rejects any bind host other than loopback", () => {
    expect(() => assert_in_memory_pairing({ ...env(), HOST: "0.0.0.0" }))
      .toThrow(/loopback-host-required/u);
  });
});

describe("synthetic credentials", () => {
  it("mints a different app secret for every process", () => {
    expect(create_local_credentials().app_secret).not.toBe(create_local_credentials().app_secret);
  });

  it("uses a channel account that is obviously not a real Meta identifier", () => {
    // The 1555 block is reserved for fiction, so a local transcript can never
    // carry a reachable business number.
    expect(LOCAL_SYNTHETIC_PHONE_NUMBER_ID).toMatch(/^1555\d{11}$/u);
  });
});

describe("synthetic availability", () => {
  it("produces slots the agent's own schema accepts", () => {
    expect(SLOTS.length).toBeGreaterThanOrEqual(3);
    for (const slot of SLOTS) expect(() => time_slot_schema.parse(slot)).not.toThrow();
  });

  it("places every slot after now with a positive duration", () => {
    const now_ms = Date.parse("2026-10-02T00:00:00.000Z");
    for (const slot of SLOTS) {
      expect(Date.parse(slot.start_iso)).toBeGreaterThan(now_ms);
      expect(Date.parse(slot.end_iso)).toBeGreaterThan(Date.parse(slot.start_iso));
    }
  });

  it("gives each slot its own provider so the slot service does not merge windows", () => {
    expect(new Set(SLOTS.map((slot) => slot.staff)).size).toBe(SLOTS.length);
  });
});
