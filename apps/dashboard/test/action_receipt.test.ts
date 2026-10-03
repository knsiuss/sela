/**
 * Security coverage for the server-side operator-action authorization boundary.
 *
 * Before the receipt existed, the dashboard decided authorization in the browser
 * against a principal the browser also supplied, so a forged principal could
 * authorize anything. These tests pin the properties that close that gap: the
 * server authorizes the exact tuple against the session principal, and a receipt
 * cannot be forged, moved to another action or tenant, reused after it expires, or
 * replayed by a different principal.
 */

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ACTION_RECEIPT_TTL_SECONDS,
  authorize_operator_action,
  issue_action_receipt,
  parse_receipt_key,
  verify_action_receipt,
  type ActionAuthorization,
} from "../src/domain/action_receipt.js";
import { parse_authenticated_principal } from "appointment-agent/dist/src/enterprise/authorization.js";
import { build_fixture_principal } from "./support/fixture_principal.js";

const KEY = parse_receipt_key(randomBytes(32).toString("base64"));
const OTHER_KEY = parse_receipt_key(randomBytes(32).toString("base64"));
const NOW_MS = Date.parse("2026-09-25T00:00:00.000Z");
const TENANT_ID = "1001";

const REQUEST: ActionAuthorization = {
  tenant_id: TENANT_ID,
  action: "resolve_conflict",
  target_id: "conflict-fixture-pending",
  reason: "operator_verified",
};

describe("action receipt signing key", () => {
  it("requires exactly 32 bytes of canonical base64", () => {
    expect(() => parse_receipt_key(undefined)).toThrow();
    expect(() => parse_receipt_key("")).toThrow();
    expect(() => parse_receipt_key(randomBytes(16).toString("base64"))).toThrow();
    expect(() => parse_receipt_key(randomBytes(32).toString("base64").replace(/=+$/u, ""))).toThrow();
  });
});

describe("server-side authorization", () => {
  it("allows an action the session role holds", () => {
    const principal = build_fixture_principal(TENANT_ID, "operator");
    expect(authorize_operator_action(principal, REQUEST)).toBeNull();
  });

  it("refuses a tenant the principal has no membership in", () => {
    const principal = build_fixture_principal(TENANT_ID, "owner");
    expect(authorize_operator_action(principal, { ...REQUEST, tenant_id: "2002" })).toBe("forbidden");
  });

  it("refuses a privileged action when MFA is unverified", () => {
    const principal = build_fixture_principal(TENANT_ID, "owner", false);
    const privileged = { ...REQUEST, action: "replay_outbound" };
    expect(authorize_operator_action(principal, privileged)).toBe("mfa_required");
  });

  it("allows a privileged action only with verified MFA", () => {
    const principal = build_fixture_principal(TENANT_ID, "owner", true);
    const privileged = { ...REQUEST, action: "replay_outbound" };
    expect(authorize_operator_action(principal, privileged)).toBeNull();
  });

  it("refuses a malformed tenant, action, target, or reason instead of authorizing", () => {
    const principal = build_fixture_principal(TENANT_ID, "owner");
    for (const bad of [
      { ...REQUEST, tenant_id: "0" },
      { ...REQUEST, action: "drop_table" },
      { ...REQUEST, target_id: "../etc/passwd" },
      { ...REQUEST, reason: "because I said so" },
    ]) {
      // The boundary reports a denial code rather than throwing, so a caller
      // cannot distinguish "refused" from "crashed" and neither can be a success.
      expect(authorize_operator_action(principal, bad)).not.toBeNull();
    }
  });

  it("refuses to mint a receipt for a malformed request", () => {
    const principal = build_fixture_principal(TENANT_ID, "owner");
    expect(() => issue_action_receipt(KEY, principal, { ...REQUEST, tenant_id: "0" }, NOW_MS)).toThrow();
    expect(() => issue_action_receipt(KEY, principal, { ...REQUEST, action: "drop_table" }, NOW_MS)).toThrow();
  });
});

describe("action receipt binding", () => {
  it("verifies for the exact tuple it was issued for", () => {
    const principal = build_fixture_principal(TENANT_ID, "operator");
    const { receipt } = issue_action_receipt(KEY, principal, REQUEST, NOW_MS);
    expect(() => verify_action_receipt(KEY, receipt, principal, REQUEST, NOW_MS + 1_000)).not.toThrow();
  });

  it("rejects a receipt presented with a different action, target, tenant, or reason", () => {
    const principal = build_fixture_principal(TENANT_ID, "owner", true);
    const { receipt } = issue_action_receipt(KEY, principal, REQUEST, NOW_MS);
    for (const moved of [
      { ...REQUEST, action: "export_audit" },
      { ...REQUEST, target_id: "conflict-fixture-other" },
      { ...REQUEST, tenant_id: "2002" },
      { ...REQUEST, reason: "audit_request" },
    ]) {
      expect(() => verify_action_receipt(KEY, receipt, principal, moved, NOW_MS + 1_000)).toThrow();
    }
  });

  it("rejects a receipt signed with a different key", () => {
    const principal = build_fixture_principal(TENANT_ID, "operator");
    const { receipt } = issue_action_receipt(KEY, principal, REQUEST, NOW_MS);
    expect(() => verify_action_receipt(OTHER_KEY, receipt, principal, REQUEST, NOW_MS + 1_000)).toThrow();
  });

  it("rejects a tampered payload", () => {
    const principal = build_fixture_principal(TENANT_ID, "operator");
    const { receipt } = issue_action_receipt(KEY, principal, REQUEST, NOW_MS);
    const parts = receipt.split(".");
    const forged = [parts[0], parts[1], parts[2], Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(parts[3] as string, "base64url").toString("utf8")), tenant_id: "2002" }), "utf8").toString("base64url"), parts[4]].join(".");
    expect(() => verify_action_receipt(KEY, forged, principal, REQUEST, NOW_MS + 1_000)).toThrow();
  });

  it("rejects a receipt after its short TTL", () => {
    const principal = build_fixture_principal(TENANT_ID, "operator");
    const { receipt, expires_at_ms } = issue_action_receipt(KEY, principal, REQUEST, NOW_MS);
    expect(expires_at_ms).toBe(NOW_MS + ACTION_RECEIPT_TTL_SECONDS * 1_000);
    expect(() => verify_action_receipt(KEY, receipt, principal, REQUEST, expires_at_ms)).toThrow();
  });

  it("rejects a receipt presented by a different principal", () => {
    const owner = build_fixture_principal(TENANT_ID, "owner", true);
    const other = parse_authenticated_principal({
      subject_id: "fixture-operator",
      tenant_roles: { [TENANT_ID]: ["owner"] },
      has_mfa: true,
      session_id: "a-different-session",
      issued_at_iso: "2026-01-01T00:00:00.000Z",
    });
    const { receipt } = issue_action_receipt(KEY, owner, REQUEST, NOW_MS);
    expect(() => verify_action_receipt(KEY, receipt, other, REQUEST, NOW_MS + 1_000)).toThrow();
  });

  it("rejects a receipt whose MFA state no longer matches the session", () => {
    const verified = build_fixture_principal(TENANT_ID, "owner", true);
    const unverified = build_fixture_principal(TENANT_ID, "owner", false);
    const { receipt } = issue_action_receipt(KEY, verified, REQUEST, NOW_MS);
    expect(() => verify_action_receipt(KEY, receipt, unverified, REQUEST, NOW_MS + 1_000)).toThrow();
  });

  it("rejects a structurally malformed receipt", () => {
    const principal = build_fixture_principal(TENANT_ID, "operator");
    for (const bad of ["", "not-a-receipt", "r1.nonce", "r1.n.1.payload.signature.extra"]) {
      expect(() => verify_action_receipt(KEY, bad, principal, REQUEST, NOW_MS)).toThrow();
    }
  });

  it("issues a distinct receipt each time", () => {
    const principal = build_fixture_principal(TENANT_ID, "operator");
    const first = issue_action_receipt(KEY, principal, REQUEST, NOW_MS);
    const second = issue_action_receipt(KEY, principal, REQUEST, NOW_MS);
    expect(first.receipt).not.toBe(second.receipt);
  });
});
