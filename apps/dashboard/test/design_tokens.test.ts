/**
 * Colour-system and theme contract, asserted against the stylesheet source.
 *
 * jsdom applies no stylesheet, so axe cannot measure contrast here either. The
 * palette is therefore checked directly: every token is read out of
 * `tokens.css` and each declared foreground/background pair is put through the
 * WCAG relative-luminance formula in both themes. Changing a hex without
 * re-checking its ratio fails this suite rather than shipping silently.
 */

import { describe, expect, it } from "vitest";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";

/** A colour pair that must stay legible, with the WCAG gate it must clear. */
interface ContrastPair {
  foreground: string;
  background: string;
  /** 4.5 for body text, 3 for non-text boundaries such as a focus ring. */
  minimum: number;
  why: string;
}

const TEXT_PAIRS: readonly ContrastPair[] = [
  { foreground: "color-text", background: "color-canvas", minimum: 4.5, why: "body text on the page" },
  { foreground: "color-text", background: "color-surface", minimum: 4.5, why: "body text on a card" },
  { foreground: "color-text", background: "color-surface-muted", minimum: 4.5, why: "text on an inset surface" },
  { foreground: "color-text", background: "color-accent-subtle", minimum: 4.5, why: "text on the active nav tint" },
  { foreground: "color-text-muted", background: "color-surface", minimum: 4.5, why: "secondary text on a card" },
  { foreground: "color-text-muted", background: "color-canvas", minimum: 4.5, why: "secondary text on the page" },
  { foreground: "color-text-muted", background: "color-accent-subtle", minimum: 4.5, why: "secondary text on the active nav tint" },
  { foreground: "color-text-subtle", background: "color-surface", minimum: 4.5, why: "field hints and captions" },
  { foreground: "color-text-subtle", background: "color-surface-muted", minimum: 4.5, why: "labels on an inset surface" },
  { foreground: "color-accent", background: "color-surface", minimum: 4.5, why: "links and the active nav item" },
  { foreground: "color-accent", background: "color-canvas", minimum: 4.5, why: "links on the page" },
  { foreground: "color-accent", background: "color-accent-subtle", minimum: 4.5, why: "the active nav item" },
  { foreground: "color-accent-contrast", background: "color-accent", minimum: 4.5, why: "primary button label" },
  { foreground: "color-accent-contrast", background: "color-accent-hover", minimum: 4.5, why: "hovered primary button label" },
  { foreground: "state-positive-fg", background: "state-positive-bg", minimum: 4.5, why: "positive badge" },
  { foreground: "state-positive-fg", background: "color-surface", minimum: 4.5, why: "positive accent on a card" },
  { foreground: "state-warning-fg", background: "state-warning-bg", minimum: 4.5, why: "warning badge and the environment notice" },
  { foreground: "state-warning-fg", background: "color-surface", minimum: 4.5, why: "warning accent on a card" },
  { foreground: "state-critical-fg", background: "state-critical-bg", minimum: 4.5, why: "critical badge" },
  { foreground: "state-critical-fg", background: "color-surface", minimum: 4.5, why: "critical accent on a card" },
  { foreground: "state-neutral-fg", background: "state-neutral-bg", minimum: 4.5, why: "neutral badge" },
  { foreground: "state-neutral-fg", background: "color-surface", minimum: 4.5, why: "neutral accent on a card" },
];

/**
 * Non-text boundaries clear the weaker 3:1 gate of WCAG 1.4.11.
 *
 * Focus rings are drawn outside the control fill, so they are measured against
 * the surfaces they can actually land on rather than against the accent.
 */
const NON_TEXT_PAIRS: readonly ContrastPair[] = [
  { foreground: "color-focus", background: "color-surface", minimum: 3, why: "focus ring on a card" },
  { foreground: "color-focus", background: "color-canvas", minimum: 3, why: "focus ring on the page" },
  { foreground: "color-focus", background: "color-surface-muted", minimum: 3, why: "focus ring on an inset surface" },
  { foreground: "color-border-control", background: "color-surface", minimum: 3, why: "input and select boundary" },
  { foreground: "color-border-control", background: "color-canvas", minimum: 3, why: "control boundary on the page" },
  { foreground: "color-border-control", background: "color-surface-muted", minimum: 3, why: "control boundary on an inset surface" },
];

const REQUIRED_TOKENS: readonly string[] = [
  "color-canvas", "color-surface", "color-surface-muted", "color-border", "color-border-control",
  "color-text", "color-text-muted", "color-text-subtle", "color-accent", "color-accent-hover",
  "color-accent-contrast", "color-accent-subtle", "color-focus",
  "state-positive-fg", "state-positive-bg", "state-positive-border",
  "state-warning-fg", "state-warning-bg", "state-warning-border",
  "state-critical-fg", "state-critical-bg", "state-critical-border",
  "state-neutral-fg", "state-neutral-bg", "state-neutral-border",
];

const TOKEN_PATTERN = /--([a-z0-9-]+):\s*light-dark\(\s*(#[0-9a-f]{6})\s*,\s*(#[0-9a-f]{6})\s*\);/giu;

/** Layers that consume the token layer, and must not declare their own colour. */
const LAYER_FILES: readonly string[] = [
  "src/styles/base.css",
  "src/styles/layout.css",
  "src/styles/components.css",
  "src/styles/data.css",
];

/** Both theme values for one token. */
interface TokenPair {
  light: string;
  dark: string;
}

/**
 * Resolve a file inside this package regardless of the launch directory.
 *
 * Vitest rewrites `import.meta.url` to an http URL under jsdom, so the search
 * walks up from the working directory instead of relying on module location.
 *
 * @param relative_path - Path relative to the package root.
 * @returns Absolute path to the file.
 * @throws Error When the file is not found, so a rename cannot pass silently.
 */
function find_package_file(relative_path: string): string {
  let current = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = resolve(current, relative_path);
    try {
      readFileSync(candidate, "utf8");
      return candidate;
    } catch {
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  throw new Error(`dashboard-test-file-missing:${relative_path}`);
}

function read_stylesheet(relative_path: string): string {
  return readFileSync(find_package_file(relative_path), "utf8");
}

/** Parse every `light-dark()` token out of the token layer. */
function tokens_of(source: string): Array<{ name: string; light: string; dark: string }> {
  return [...source.matchAll(TOKEN_PATTERN)].map((match) => ({
    name: match[1],
    light: match[2].toLowerCase(),
    dark: match[3].toLowerCase(),
  }));
}

function read_tokens(): ReadonlyMap<string, TokenPair> {
  return new Map(tokens_of(read_stylesheet("src/styles/tokens.css")).map((token) => [
    token.name,
    { light: token.light, dark: token.dark },
  ]));
}

function channel(value: number): number {
  const scaled = value / 255;
  return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

/**
 * WCAG relative luminance of a `#rrggbb` colour.
 *
 * @param hex - Six-digit hex colour.
 * @returns Relative luminance in [0, 1].
 */
function luminance(hex: string): number {
  const r = channel(Number.parseInt(hex.slice(1, 3), 16));
  const g = channel(Number.parseInt(hex.slice(3, 5), 16));
  const b = channel(Number.parseInt(hex.slice(5, 7), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * WCAG contrast ratio between two colours.
 *
 * @param foreground - Text or boundary colour.
 * @param background - Surface it is drawn on.
 * @returns Ratio from 1 to 21.
 */
function contrast_ratio(foreground: string, background: string): number {
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function require_token(tokens: ReadonlyMap<string, TokenPair>, name: string): TokenPair {
  const token = tokens.get(name);
  if (token === undefined) throw new Error(`dashboard-token-missing:${name}`);
  return token;
}

describe("token layer", () => {
  it("declares every required semantic token", () => {
    const tokens = read_tokens();
    expect([...REQUIRED_TOKENS.filter((name) => !tokens.has(name))]).toEqual([]);
  });

  it("declares every colour through light-dark(), so the themes cannot drift", () => {
    const source = read_stylesheet("src/styles/tokens.css");
    const paired = new Set(tokens_of(source).flatMap((token) => [token.light, token.dark]));
    const literals = (source.match(/#[0-9a-f]{6}\b/giu) ?? []).map((value) => value.toLowerCase());
    expect(literals.length).toBeGreaterThan(0);
    // A colour written anywhere other than a light-dark() pair would apply to one
    // theme only, which is exactly the drift this file exists to prevent.
    expect([...new Set(literals.filter((value) => !paired.has(value)))]).toEqual([]);
  });

  it("declares no token that nothing consumes", () => {
    const source = read_stylesheet("src/styles/tokens.css");
    const declared = [...source.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gimu)].map((match) => match[1]);
    const consumed = LAYER_FILES.map((layer) => read_stylesheet(layer)).join("\n");
    const orphans = declared.filter((name) => !consumed.includes(`var(${name})`));
    expect(orphans).toEqual([]);
  });

  it("supports both colour schemes and lets the theme toggle override them", () => {
    const tokens_source = read_stylesheet("src/styles/tokens.css");
    expect(tokens_source).toMatch(/color-scheme:\s*light dark;/u);
    expect(tokens_source).toMatch(/:root\[data-theme="dark"\]/u);
    expect(tokens_source).toMatch(/:root\[data-theme="light"\]/u);
  });

  it("keeps colour out of every layer except the token file", () => {
    for (const layer of LAYER_FILES) {
      const hex_literals = read_stylesheet(layer).match(/#[0-9a-f]{3,8}\b/giu) ?? [];
      expect(hex_literals, `${layer} must reference tokens, not literals`).toEqual([]);
    }
  });
});

describe("palette contrast", () => {
  const tokens = read_tokens();

  for (const pair of TEXT_PAIRS) {
    it(`keeps ${pair.why} at 4.5:1 in both themes`, () => {
      const foreground = require_token(tokens, pair.foreground);
      const background = require_token(tokens, pair.background);
      const light = contrast_ratio(foreground.light, background.light);
      const dark = contrast_ratio(foreground.dark, background.dark);
      expect(light, `light ${pair.foreground} on ${pair.background}`).toBeGreaterThanOrEqual(pair.minimum);
      expect(dark, `dark ${pair.foreground} on ${pair.background}`).toBeGreaterThanOrEqual(pair.minimum);
    });
  }

  for (const pair of NON_TEXT_PAIRS) {
    it(`keeps ${pair.why} at 3:1 in both themes`, () => {
      const foreground = require_token(tokens, pair.foreground);
      const background = require_token(tokens, pair.background);
      const light = contrast_ratio(foreground.light, background.light);
      const dark = contrast_ratio(foreground.dark, background.dark);
      expect(light, `light ${pair.foreground} on ${pair.background}`).toBeGreaterThanOrEqual(pair.minimum);
      expect(dark, `dark ${pair.foreground} on ${pair.background}`).toBeGreaterThanOrEqual(pair.minimum);
    });
  }
});

describe("accessibility primitives", () => {
  it("declares a visible focus ring on focus-visible", () => {
    const source = read_stylesheet("src/styles/base.css");
    const rule = /:focus-visible\s*\{([^}]*)\}/u.exec(source);
    expect(rule, "a :focus-visible rule must exist").toBeTruthy();
    const width = /outline:\s*(\d+)px/u.exec(rule?.[1] ?? "");
    expect(Number(width?.[1] ?? 0)).toBeGreaterThanOrEqual(2);
  });

  it("collapses motion when the operator asks for reduced motion", () => {
    expect(read_stylesheet("src/styles/base.css")).toMatch(/@media \(prefers-reduced-motion: reduce\)/u);
  });

  it("keeps the visually-hidden utility available to assistive technology", () => {
    expect(read_stylesheet("src/styles/base.css")).toMatch(/\.sr-only\s*\{/u);
  });
});

describe("responsive affordances", () => {
  it("marks the horizontal scroll container so a sticky header can still stick", () => {
    const source = read_stylesheet("src/styles/data.css");
    const rule = /\.table-scroll\s*\{([^}]*)\}/u.exec(source);
    expect(rule).toBeTruthy();
    expect(rule?.[1]).toMatch(/overflow-x:\s*auto;/u);
    // `clip` rather than `visible`/`auto`: an auto or scroll value here would make
    // the wrapper a vertical scroll container and silently break the sticky header.
    expect(rule?.[1]).toMatch(/overflow-y:\s*clip;/u);
  });

  it("shows the scroll hint only where the table can overflow", () => {
    const source = read_stylesheet("src/styles/data.css");
    expect(source).toMatch(/\.table-hint\s*\{\s*display:\s*none;/u);
    expect(source).toMatch(/@media \(max-width: 640px\)\s*\{[^@]*?\.table-hint\s*\{\s*display:\s*block;/us);
  });
});