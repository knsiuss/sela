// @vitest-environment jsdom

/**
 * Semantic state presentation contract.
 *
 * Two properties are asserted. First, every domain state maps to an explicit
 * tone, so a new state cannot silently render grey on one board. Second, each
 * rendered badge carries a text label AND a shape marker, which is what keeps
 * the state readable without colour (WCAG 1.4.1).
 */

import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { AppointmentTable } from "../src/components/AppointmentTable";
import { ConflictBoard } from "../src/components/ConflictBoard";
import { QueueBoard } from "../src/components/QueueBoard";
import { DEFAULT_TONE, KNOWN_STATUSES, is_known_status, status_tone } from "../src/components/status_tone";
import { build_test_snapshot, render_workspace, TEST_TENANT_ID } from "./support/render_workspace.js";

/** Tones the boards rely on, so a collapsing map is caught. */
const REQUIRED_TONES = ["neutral", "positive", "warning", "critical"] as const;

/** The mapping the UI is contractually required to render. */
const EXPECTED_TONES: Readonly<Record<string, string>> = {
  confirmed: "positive",
  held: "warning",
  cancelled: "neutral",
  completed: "neutral",
  no_show: "critical",
  pending: "warning",
  proposed: "warning",
  accepted: "positive",
  rejected: "critical",
  expired: "neutral",
  unassigned: "warning",
  assigned: "neutral",
  escalated: "critical",
  resolved: "positive",
  on_track: "positive",
  due_soon: "warning",
  breached: "critical",
  met: "neutral",
  succeeded: "positive",
  denied: "critical",
  failed: "warning",
};

/** Render every board that carries a status badge. */
function render_every_board(): void {
  const snapshot = build_test_snapshot();
  render_workspace(
    <>
      <h1>Workspace</h1>
      <AppointmentTable rows={snapshot.appointments} tenant_id={TEST_TENANT_ID} />
      <ConflictBoard tenant_id={TEST_TENANT_ID} />
      <QueueBoard tenant_id={TEST_TENANT_ID} />
    </>,
  );
}

function rendered_badges(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("[data-status]")];
}

describe("status_tone", () => {
  it("maps every listed domain state to its contract tone", () => {
    for (const status of KNOWN_STATUSES) {
      expect(status_tone(status), `tone for ${status}`).toBe(EXPECTED_TONES[status]);
    }
  });

  it("lists no state that the map does not know", () => {
    expect(KNOWN_STATUSES.filter((status) => !is_known_status(status))).toEqual([]);
  });

  it("uses every tone at least once, so the palette is not collapsing", () => {
    const used = new Set(KNOWN_STATUSES.map((status) => status_tone(status)));
    expect([...used].sort()).toEqual([...REQUIRED_TONES].sort());
  });

  it("falls back to the neutral tone for an unknown state instead of throwing", () => {
    expect(status_tone("not_a_real_state")).toBe(DEFAULT_TONE);
    expect(is_known_status("not_a_real_state")).toBe(false);
  });
});

describe("rendered badges", () => {
  it("gives every badge a text label, a marker, and the mapped tone class", () => {
    render_every_board();
    const badges = rendered_badges();
    expect(badges.length).toBeGreaterThan(0);
    for (const badge of badges) {
      const status = badge.getAttribute("data-status") ?? "";
      expect((badge.textContent ?? "").trim().length, `label for ${status}`).toBeGreaterThan(0);
      expect(badge.querySelector(".badge__marker"), `marker for ${status}`).toBeTruthy();
      expect(badge.classList.contains(`badge--${status_tone(status)}`), `tone class for ${status}`).toBe(true);
    }
  });

  it("hides the shape marker from assistive technology", () => {
    render_every_board();
    for (const marker of document.querySelectorAll(".badge__marker")) {
      expect(marker.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("covers the conflict lifecycle end to end, terminal states included", () => {
    render_workspace(<ConflictBoard tenant_id={TEST_TENANT_ID} />);
    const rendered = new Set(rendered_badges().map((badge) => badge.getAttribute("data-status")));
    for (const status of ["pending", "proposed", "accepted", "rejected", "expired"]) {
      expect(rendered.has(status), `conflicts rendered ${status}`).toBe(true);
    }
  });

  it("covers the queue and SLA states end to end", () => {
    render_workspace(<QueueBoard tenant_id={TEST_TENANT_ID} />);
    const rendered = new Set(rendered_badges().map((badge) => badge.getAttribute("data-status")));
    for (const status of ["unassigned", "assigned", "escalated", "resolved", "on_track", "due_soon", "breached", "met"]) {
      expect(rendered.has(status), `queue rendered ${status}`).toBe(true);
    }
  });

  it("tints the card edge from the item status, not from colour alone", () => {
    render_workspace(<QueueBoard tenant_id={TEST_TENANT_ID} />);
    const cards = [...document.querySelectorAll(".card")];
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      const status = card.getAttribute("data-card-status") ?? "";
      expect(is_known_status(status), `card status ${status}`).toBe(true);
    }
    expect(screen.getByRole("group", { name: "queue-fixture-unassigned" })).toBeTruthy();
  });
});