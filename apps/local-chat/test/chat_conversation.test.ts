/**
 * The client may only replay actions the agent itself offered.
 *
 * That single rule is the client's whole safety story: it cannot invent a
 * generation-bound id, cannot reach a button from another conversation, and
 * cannot send anything the agent did not put in front of the user.
 */

import { describe, expect, it } from "vitest";
import { ChatInputError, LocalChatConversation } from "../src/chat_conversation.js";

const BASE = { tenant_id: "1", role: "end user", webhook_path: "/webhooks/whatsapp" };

function conversation(): LocalChatConversation {
  return new LocalChatConversation("end-user-1", "15550100001", () => new Date("2026-10-02T00:00:00.000Z"));
}

function offered(): LocalChatConversation {
  const open = conversation();
  open.record_agent_reply("Available appointment times:", [
    { id: "pick_slot_1_g1", label: "Pick slot 1" },
    { id: "change_day_g1", label: "Change day" },
  ]);
  return open;
}

describe("text input", () => {
  it("trims an acceptable body", () => {
    expect(conversation().require_text("  I want to book  ")).toBe("I want to book");
  });

  it("rejects an empty or non-string body", () => {
    expect(() => conversation().require_text("   ")).toThrow(ChatInputError);
    expect(() => conversation().require_text(42)).toThrow(/text-invalid/u);
  });

  it("rejects a body over the WhatsApp text limit", () => {
    expect(() => conversation().require_text("a".repeat(4_097))).toThrow(/text-too-long/u);
  });
});

describe("offered action provenance", () => {
  it("accepts an action the agent offered in this conversation", () => {
    expect(offered().require_offered_button("pick_slot_1_g1")).toBe("pick_slot_1_g1");
  });

  it("rejects an action id the agent never offered", () => {
    expect(() => conversation().require_offered_button("pick_slot_1_g1"))
      .toThrow(/button-not-offered/u);
  });

  it("rejects a generation the agent did not issue", () => {
    const open = offered();
    expect(() => open.require_offered_button("pick_slot_1_g99")).toThrow(/button-not-offered/u);
  });

  it("rejects an id outside the agent's wire alphabet", () => {
    for (const id of ["Pick Slot 1", "pick slot", "pick_slot_1_g1;", "a".repeat(65), ""]) {
      expect(() => offered().require_offered_button(id)).toThrow(/button-id-invalid/u);
    }
  });

  it("rejects a non-string id", () => {
    expect(() => offered().require_offered_button({ id: "pick_slot_1_g1" })).toThrow(/button-id-invalid/u);
  });

  it("returns the label the agent attached, because the retained row stores it", () => {
    expect(offered().require_offered_label("pick_slot_1_g1")).toBe("Pick slot 1");
  });

  it("does not carry offers between conversations", () => {
    const first = offered();
    first.require_offered_button("pick_slot_1_g1");
    expect(() => conversation().require_offered_button("pick_slot_1_g1")).toThrow(/button-not-offered/u);
  });
});

describe("public projection", () => {
  it("exposes the transcript and nothing sensitive", () => {
    const open = offered();
    open.record_end_user_turn("I want to book an appointment", {
      http_status: 200,
      wamid: "wamid.LOCAL.000001",
      request_id: "6f1c1a52-0000-4000-8000-000000000001",
      received_count: 1,
      enqueued_count: 1,
      duplicate_count: 0,
      unresolved_count: 0,
      provider_wamids: ["wamid.inmemory.1"],
    });
    const view = open.to_public_view(BASE);
    expect(view.end_user_ref).toBe("end-user-1");
    expect(view.entries.map((entry) => entry.role)).toEqual(["agent", "end_user"]);
    expect(view.wamid_sequence).toBe(0);
  });

  it("never carries the synthetic number, a credential, or an agent-internal id", () => {
    const open = offered();
    open.record_system_note("note");
    const rendered = JSON.stringify(open.to_public_view(BASE));
    expect(rendered).not.toContain("15550100001");
    expect(rendered).not.toContain("app_secret");
    expect(rendered).not.toContain("conversation_id");
  });

  it("returns defensive copies so a caller cannot mutate stored state", () => {
    const open = offered();
    const first = open.to_public_view(BASE);
    first.entries[0]?.buttons.push({ id: "pick_slot_9_g9", label: "Injected" });
    expect(open.to_public_view(BASE).entries[0]?.buttons).toHaveLength(2);
  });

  it("counts the inbound WAMID ordinal it has minted", () => {
    const open = conversation();
    expect(open.to_public_view(BASE).wamid_sequence).toBe(0);
    open.next_inbound_wamid();
    open.next_inbound_wamid();
    expect(open.to_public_view(BASE).wamid_sequence).toBe(2);
  });
});

describe("constructor validation", () => {
  it("rejects a persona ref that is not an opaque label", () => {
    expect(() => new LocalChatConversation("end user 1!", "15550100001")).toThrow(ChatInputError);
  });

  it("rejects a sender that is not digits-only E.164 material", () => {
    expect(() => new LocalChatConversation("end-user-1", "+15550100001")).toThrow(/end-user-number-invalid/u);
  });
});
