import { describe, expect, it } from "vitest";
import { get_health } from "../src/index.js";

describe("get_health", () => {
  it("reports a healthy dashboard app", () => {
    expect(get_health()).toEqual({ ok: true, app: "dashboard" });
  });
});
