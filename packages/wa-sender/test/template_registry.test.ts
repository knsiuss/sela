import { describe, expect, it } from "vitest";
import {
  contains_promotional_content,
  MAX_TEMPLATE_BUTTON_LABEL_CHARS,
  TemplateRegistrationError,
  TemplateRegistry,
  get_template,
  register_template,
} from "../src/index.js";

describe("utility template registry", () => {
  it("registers built-ins defensively and rejects unknown templates", () => {
    const registry = new TemplateRegistry();
    const definition = registry.get("confirm_prompt");
    expect(definition?.category).toBe("utility");
    expect(registry.require("confirm_prompt")).toEqual(definition);
    expect(() => registry.require("unknown_template")).toThrow(TemplateRegistrationError);
  });

  it("rejects marketing, promotional, and oversized button definitions", () => {
    const registry = new TemplateRegistry([]);
    expect(() => registry.register({ name: "bad_category", category: "marketing", body: "Hello" })).toThrow(
      TemplateRegistrationError,
    );
    expect(() => registry.register({ name: "bad_promo", category: "utility", body: "Free bonus" })).toThrow(
      TemplateRegistrationError,
    );
    expect(() =>
      registry.register({
        name: "bad_button",
        category: "utility",
        body: "Hello",
        button_label: "x".repeat(MAX_TEMPLATE_BUTTON_LABEL_CHARS + 1),
      }),
    ).toThrow(TemplateRegistrationError);
  });

  it("uses process helpers without exposing mutable definitions", () => {
    const definition = get_template("appointment_reminder");
    expect(definition).toBeDefined();
    if (definition !== undefined) definition.body = "changed";
    expect(get_template("appointment_reminder")?.body).toContain("Reminder");
    expect(contains_promotional_content("PROMO")).toBe(true);
    expect(() => register_template({ name: "duplicate", category: "utility", body: "One" })).not.toThrow();
  });
});
