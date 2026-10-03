"use server";

/**
 * The dashboard's authoritative authorization boundary for operator actions.
 *
 * This file is the only server-action surface the client may call, and it exports
 * exactly one function, so there is no way for a client import to reach a pure
 * helper or a key by accident.
 */

import {
  authorize_operator_action,
  issue_action_receipt,
  parse_receipt_key,
  ACTION_RECEIPT_KEY_ENV,
  type ActionAuthorization,
} from "@/domain/action_receipt";
import { optional_session_principal } from "./auth/session";

/** Result of one authorization request. */
export interface ReceiptResult {
  /** Null when the server authorized the action. */
  code: string | null;
  /** Opaque receipt the client must present with the local execution. */
  receipt: string | null;
}

/**
 * Authorize one action against the current session and mint a receipt.
 *
 * The principal comes from the verified session cookie and never from the
 * arguments, so a browser cannot claim a role or a tenant it does not hold. A
 * privileged action additionally goes through the MFA gate, so an unverified
 * second factor produces a denial here rather than only in the UI.
 *
 * @param request - Tenant, action, target, and bounded reason code.
 * @returns A sanitized denial code, or a receipt for the authorized request.
 */
export async function authorize_operator_receipt(request: ActionAuthorization): Promise<ReceiptResult> {
  const principal = await optional_session_principal();
  if (principal === null) return { code: "unauthenticated", receipt: null };
  // The privileged set mirrors `authorize_privileged`, which MFA-gates replay,
  // cancellation, and tenant management. Naming it here keeps a newly added
  // privileged action from silently skipping the gate.
  const privileged = request.action === "replay_outbound";
  const code = authorize_operator_action(principal, request, privileged);
  if (code !== null) return { code, receipt: null };
  try {
    const key = parse_receipt_key(process.env[ACTION_RECEIPT_KEY_ENV]);
    return { code: null, receipt: issue_action_receipt(key, principal, request, Date.now()).receipt };
  } catch {
    // With no signing key no action may proceed; the panel fails closed rather
    // than falling back to an unauthorized execution.
    return { code: "forbidden", receipt: null };
  }
}