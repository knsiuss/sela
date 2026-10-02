"use client";

/**
 * Explicit light/dark override for the operator workspace.
 *
 * The dark theme works without this control: `tokens.css` resolves every colour
 * through `light-dark()`, which the bundler lowers to a
 * `prefers-color-scheme` media query, so the workspace already follows the
 * operating system. This button only pins a choice for an operator whose OS
 * preference does not match the room they are working in.
 *
 * When nothing is pinned the `data-theme` attribute is REMOVED rather than set,
 * so the media query stays in charge and the workspace keeps following the OS
 * live. Only an explicit choice writes the attribute.
 *
 * Hydration safety: the stored preference is read in an effect, never during
 * render, so the first client render is byte-identical to the server render and
 * the control can never report a theme the server did not render. It settles
 * one frame later.
 *
 * Accessibility: a real `<button>` with `aria-pressed`, so the state is exposed
 * as a toggle rather than only as a colour change, and the name stays stable so
 * the control is findable by name.
 *
 * Nothing is read from or written to the network, and the stored value is a
 * theme name only: no tenant, role, or record data ever reaches storage.
 */

import { useEffect, useState, type ReactElement } from "react";

/** The two themes the workspace ships. */
type Theme = "light" | "dark";

/** Attribute that overrides the media query, and the local storage key. */
const OVERRIDE_ATTRIBUTE = "data-theme";
const STORAGE_KEY = "dashboard-theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * Render the colour-theme toggle.
 *
 * @returns The toggle button.
 */
export function ThemeToggle(): ReactElement {
  const [theme, set_theme] = useState<Theme | null>(null);

  useEffect(() => {
    const pinned = read_preference();
    set_theme(pinned ?? system_theme());
    apply_pinned_theme(pinned);
    return observe_system_theme(set_theme);
  }, []);

  function toggle(): void {
    const next: Theme = theme === "dark" ? "light" : "dark";
    set_theme(next);
    write_preference(next);
    apply_pinned_theme(next);
  }

  return (
    <button
      type="button"
      className="theme-toggle"
      aria-pressed={theme === "dark"}
      onClick={toggle}
    >
      {theme === "dark" ? "Dark theme" : "Light theme"}
    </button>
  );
}

/**
 * Read the explicitly chosen theme, if the operator has made one.
 *
 * @returns The stored theme, or null when storage is unavailable or empty.
 */
function read_preference(): Theme | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : null;
  } catch {
    // Storage can be unavailable (private mode, disabled cookies). Following the
    // OS preference is the correct fallback, not a failure.
    return null;
  }
}

/**
 * Pin the operator's choice.
 *
 * @param theme - Theme to remember.
 */
function write_preference(theme: Theme): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // The toggle still works for this session even if the choice cannot persist.
  }
}

/**
 * Apply, or release, the document-level theme override.
 *
 * @param theme - Theme to pin, or null to hand control back to the OS.
 */
function apply_pinned_theme(theme: Theme | null): void {
  const root = document.documentElement;
  if (theme === null) root.removeAttribute(OVERRIDE_ATTRIBUTE);
  else root.setAttribute(OVERRIDE_ATTRIBUTE, theme);
}

/**
 * Theme implied by the operating system.
 *
 * `matchMedia` is probed defensively: a hardened profile can leave it
 * unavailable, and an unavailable media query means "no dark preference", not a
 * broken control.
 */
function system_theme(): Theme {
  return matches_dark_scheme() ? "dark" : "light";
}

function matches_dark_scheme(): boolean {
  try {
    return window.matchMedia(DARK_QUERY).matches;
  } catch {
    return false;
  }
}

/**
 * Keep the button truthful while no explicit choice is pinned.
 *
 * Only relevant when the media query is in charge: a pinned theme must not be
 * overridden by an OS change, which is exactly what `is_pinned` checks.
 *
 * @param on_change - Receives the new effective theme.
 * @returns Cleanup that removes the listener.
 */
function observe_system_theme(on_change: (theme: Theme) => void): () => void {
  let media: MediaQueryList;
  try {
    media = window.matchMedia(DARK_QUERY);
  } catch {
    return () => undefined;
  }
  const listener = (): void => {
    if (read_preference() === null) on_change(system_theme());
  };
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}