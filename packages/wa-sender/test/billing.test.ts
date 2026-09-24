import { describe, expect, it } from "vitest";
import {
  BillingNormalizationError,
  normalize_billing_tag,
  normalize_delivery_receipt,
  normalize_delivery_receipts,
  try_normalize_delivery_receipt,
} from "../src/index.js";

describe("WhatsApp billing and delivery normalization", () => {
  it("keeps only safe status and pricing fields", () => {
    const receipt = normalize_delivery_receipt({
      id: "wamid-1",
      status: "delivered",
      timestamp: "1780000000",
      pricing: {
        billable: true,
        pricing_model: "CBP",
        category: "utility",
        type: "template",
      },
      from: "+12025550100",
      errors: [{ code: 131009, message: "private provider detail" }],
    });
    expect(receipt).toEqual({
      wamid: "wamid-1",
      status: "delivered",
      occurred_at_iso: new Date(1_780_000_000_000).toISOString(),
      billing: { billable: true, pricing_model: "CBP", category: "utility", type: "template" },
      error_code: "131009",
    });
    expect(JSON.stringify(receipt)).not.toContain("12025550100");
    expect(JSON.stringify(receipt)).not.toContain("private provider detail");
  });

  it("walks the nested Meta webhook shape and preserves message order", () => {
    const receipts = normalize_delivery_receipts({
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  { id: "wamid-1", status: "sent" },
                  { id: "wamid-2", status: "failed", errors: [{ code: "131051" }] },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(receipts.map((receipt) => receipt.wamid)).toEqual(["wamid-1", "wamid-2"]);
    expect(receipts[1]?.error_code).toBe("131051");
    expect(normalize_delivery_receipts([{ id: "wamid-3", status: "sent" }])).toEqual([
      { wamid: "wamid-3", status: "sent" },
    ]);
  });

  it("rejects malformed pricing and unknown delivery states", () => {
    expect(() => normalize_billing_tag({ billable: true, pricing_model: "CBP", type: "template", category: "unknown" })).toThrow(
      BillingNormalizationError,
    );
    expect(() => normalize_delivery_receipt({ id: "wamid-1", status: "deleted" })).toThrow(
      BillingNormalizationError,
    );
    expect(try_normalize_delivery_receipt({ id: "wamid-1", status: "deleted" })).toBeUndefined();
  });

  it("accepts absent pricing and invalid timestamps without retaining them", () => {
    const receipt = normalize_delivery_receipt({ id: "wamid-1", status: "read", timestamp: "not-a-timestamp" });
    expect(receipt).toEqual({ wamid: "wamid-1", status: "read" });
  });
});
