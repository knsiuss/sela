// @vitest-environment jsdom

/**
 * Theme override behaviour.
 *
 * The CSS alone already follows `prefers-color-scheme`; this control only pins a
 * choice. The assertions below protect the two properties that are easy to
 * break: the override actually reaches the document, and releasing it hands
 * control back to the operating system instead of freezing the last value.
 */

import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeToggle } from "../src/components/ThemeToggle";
import { render_workspace } from "./support/render_workspace.js";

/** Clear any override so each case starts from the OS default. */
function reset_theme(): void {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
}

describe("ThemeToggle", () => {
  it("starts unpinned, leaving the media query in charge", async () => {
    reset_theme();
    render_workspace(<h1>Workspace</h1>);
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("exposes its state as a toggle rather than only as a colour change", () => {
    reset_theme();
    render_workspace(<h1>Workspace</h1>);
    expect(screen.getByRole("button", { name: /theme/u }).getAttribute("aria-pressed")).toBe("false");
  });

  it("pins the chosen theme onto the document and into local storage", async () => {
    reset_theme();
    const user = userEvent.setup();
    render_workspace(<h1>Workspace</h1>);
    await user.click(screen.getByRole("button", { name: /theme/u }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(window.localStorage.getItem("dashboard-theme")).toBe("dark");
    expect(screen.getByRole("button", { name: /theme/u }).getAttribute("aria-pressed")).toBe("true");
  });

  it("toggles back to light on a second activation", async () => {
    reset_theme();
    const user = userEvent.setup();
    render_workspace(<h1>Workspace</h1>);
    const toggle = () => screen.getByRole("button", { name: /theme/u });
    await user.click(toggle());
    await user.click(toggle());
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("stores only a theme name, never workspace data", async () => {
    reset_theme();
    const user = userEvent.setup();
    render_workspace(<h1>Workspace</h1>);
    await user.click(screen.getByRole("button", { name: /theme/u }));
    const stored = window.localStorage.getItem("dashboard-theme") ?? "";
    expect(stored === "light" || stored === "dark").toBe(true);
    expect(stored).not.toMatch(/\d/u);
  });
});