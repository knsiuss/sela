/**
 * Vitest setup for the dashboard app.
 *
 * The suite runs with `globals: false`, so Testing Library cannot register its
 * own automatic cleanup. Without this, every render would accumulate in one
 * document and role queries would match stale nodes.
 */

import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});

// jsdom has no canvas implementation, and axe-core probes it while computing
// colour-contrast data. A null context is the documented jsdom workaround; the
// rule still runs and reports `incomplete` where jsdom cannot measure.
if (typeof HTMLCanvasElement !== "undefined") {
  HTMLCanvasElement.prototype.getContext = () => null;
}