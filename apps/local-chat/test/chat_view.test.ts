/**
 * The page is built by string concatenation, so escaping is the XSS boundary.
 *
 * These assertions keep that boundary honest and keep the two local surfaces
 * sharing one security framing instead of drifting apart.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LocalOnlyBanner } from "@repo/ui";
import type { PublicChatView } from "../src/chat_conversation.js";
import { escape_html, render_chat_page, render_client_script, render_transcript } from "../src/chat_view.js";

const CONTEXT = {
  tenant_id: "1",
  role: "end user",
  webhook_path: "/webhooks/whatsapp",
  reply_timeout_ms: 8_000,
};

function view(overrides: Partial<PublicChatView> = {}): PublicChatView {
  return {
    end_user_ref: "end-user-1",
    tenant_id: "1",
    role: "end user",
    webhook_path: "/webhooks/whatsapp",
    wamid_sequence: 0,
    entries: [
      {
        role: "end_user",
        text: "I want to book an appointment",
        buttons: [],
        at_iso: "2026-10-02T00:00:00.000Z",
        evidence: {
          http_status: 200,
          wamid: "wamid.LOCAL.000001",
          request_id: "6f1c1a52-0000-4000-8000-000000000001",
          received_count: 1,
          enqueued_count: 1,
          duplicate_count: 0,
          unresolved_count: 0,
          provider_wamids: ["wamid.inmemory.1"],
        },
      },
      {
        role: "agent",
        text: "Available appointment times:\n1. 2026-10-03T09:00:00.000Z",
        buttons: [
          { id: "pick_slot_1_g1", label: "Pick slot 1" },
          { id: "change_day_g1", label: "Change day" },
        ],
        at_iso: "2026-10-02T00:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

describe("page structure", () => {
  it("renders a complete document with a main landmark and a transcript log", () => {
    const html = render_chat_page(view(), CONTEXT);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("<main>");
    expect(html).toContain('role="log"');
    expect(html).toContain('id="message"');
  });

  it("carries the shared local-only notice from the dashboard component", () => {
    const html = render_chat_page(view(), CONTEXT);
    expect(html).toContain("Local development build. No authentication.");
    expect(html).toContain("All records are synthetic fixtures.");
    expect(html).toContain("Do not expose this interface beyond localhost");
    expect(html).toContain('aria-label="Environment warning"');
  });

  it("uses the same notice markup the shared component produces", () => {
    const page = /<aside class="banner"[\s\S]*?<\/aside>/u.exec(render_chat_page(view(), CONTEXT))?.[0] ?? "";
    expect(page).toBe(renderToStaticMarkup(LocalOnlyBanner({ tenant_id: "1", role: "end user" })));
  });

  it("names the end-user persona and the real webhook path", () => {
    const html = render_chat_page(view(), CONTEXT);
    expect(html).toContain(">end user</strong>");
    expect(html).toContain("/webhooks/whatsapp");
  });

  it("shows the observed ingress evidence for the last turn", () => {
    const html = render_chat_page(view(), CONTEXT);
    expect(html).toContain("HTTP 200");
    expect(html).toContain("wamid.LOCAL.000001");
    expect(html).toContain("wamid.inmemory.1");
  });

  it("offers a real button per action the agent emitted", () => {
    const html = render_chat_page(view(), CONTEXT);
    expect(html).toContain('data-button-id="pick_slot_1_g1"');
    expect(html).toContain('data-button-id="change_day_g1"');
    expect(html).toContain(">Pick slot 1</button>");
  });
});

describe("escaping", () => {
  it("escapes the five dangerous characters", () => {
    expect(escape_html("<a href=\"x\" id='y'>&</a>")).toBe(
      "&lt;a href=&quot;x&quot; id=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });

  it("never emits injected markup from a transcript line", () => {
    const hostile = view({
      entries: [
        {
          role: "agent",
          text: "<script>fetch('http://evil.example')</script>",
          buttons: [{ id: "pick_slot_1_g1", label: "\"><script>x</script>" }],
          at_iso: "2026-10-02T00:00:00.000Z",
        },
      ],
    });
    const html = render_chat_page(hostile, CONTEXT);
    expect(html).not.toContain("<script>fetch");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("evil.example");
  });

  it("uses no inline event handlers and no raw HTML injection", () => {
    const html = render_chat_page(view(), CONTEXT);
    expect(html).not.toMatch(/ on[a-z]+="/u);
    expect(html).not.toContain("dangerouslySetInnerHTML");
  });
});

describe("transcript rendering", () => {
  it("shows an empty state before the first turn", () => {
    expect(render_transcript({ ...view(), entries: [] })).toContain("No messages yet");
  });

  it("labels the three transcript roles distinctly", () => {
    const html = render_transcript({
      ...view(),
      entries: [
        { role: "end_user", text: "hi", buttons: [], at_iso: "2026-10-02T00:00:00.000Z" },
        { role: "agent", text: "hello", buttons: [], at_iso: "2026-10-02T00:00:00.000Z" },
        { role: "system", text: "note", buttons: [], at_iso: "2026-10-02T00:00:00.000Z" },
      ],
    });
    expect(html).toContain(">You</span>");
    expect(html).toContain(">Booking agent</span>");
    expect(html).toContain(">Chat client</span>");
  });
});

describe("client script", () => {
  it("is same-origin only, with no eval and no external reference", () => {
    const script = render_client_script();
    expect(script).not.toContain("eval(");
    expect(script).not.toContain("http://");
    expect(script).not.toContain("https://");
    expect(script).toContain("post('/chat/turns'");
    expect(script).toContain("post('/chat/sessions'");
  });

  it("escapes text through the DOM rather than string concatenation", () => {
    expect(render_client_script()).toContain("div.textContent = value;");
  });
});

describe("shared component identity", () => {
  it("still exports the notice the dashboard renders", () => {
    expect(typeof LocalOnlyBanner).toBe("function");
  });
});
