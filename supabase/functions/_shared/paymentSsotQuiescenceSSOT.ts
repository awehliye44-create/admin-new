/**
 * Mixed-version / rollback quiescence for Payment SSOT (#92B).
 *
 * Stage D strict enforcement must not activate while incompatible (pre-fence)
 * workers remain the only capture path — operational gate.
 * Edge rollback to 871c73ac must wait until no provider POSTs are inflight.
 * Never drop payment_financial_operations / snapshots / events in production.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";

export type InflightFinancialOpSummary = {
  inflight_count: number;
  unresolved_count: number;
  sample_execution_ids: string[];
};

const UNRESOLVED_STATES = [
  "INCREMENT_REQUESTED",
  "INCREMENT_PENDING",
  "INCREMENT_UNKNOWN",
  "CAPTURE_REQUESTED",
  "CAPTURE_PENDING",
  "CAPTURE_UNKNOWN",
  "RECONCILING",
] as const;

/** Safe to roll Edge back to 871c73ac only when no provider POST is inflight/unresolved. */
export function decideEdgeRollbackSafety(
  summary: InflightFinancialOpSummary,
): { ok: true } | { ok: false; reason: string } {
  if (summary.inflight_count > 0) {
    return {
      ok: false,
      reason: `provider_post_inflight=${summary.inflight_count}; reconcile-only until clear`,
    };
  }
  if (summary.unresolved_count > 0) {
    return {
      ok: false,
      reason: `unresolved_financial_ops=${summary.unresolved_count}; quiesce before rollback`,
    };
  }
  return { ok: true };
}

/**
 * Pure binding check — confirmed capture must match the claimed order/session/currency/amount.
 * Never confirm from requested amounts or HTTP acceptance alone.
 */
export function assertProviderCaptureEvidenceBinding(args: {
  claimedProviderOrderId: string;
  retrievedOrderId: string | null | undefined;
  claimedPaymentSessionId: string;
  operationPaymentSessionId?: string | null;
  claimedCurrency: string;
  retrievedCurrency?: string | null;
  requestedAmountPence: number;
  confirmedAmountPence: number | null | undefined;
  providerTerminal: boolean;
}): { ok: true } | { ok: false; reason: string } {
  const claimedOrder = String(args.claimedProviderOrderId ?? "").trim();
  const retrievedOrder = String(args.retrievedOrderId ?? "").trim();
  if (!claimedOrder || !retrievedOrder || claimedOrder !== retrievedOrder) {
    return { ok: false, reason: "provider_order_id_mismatch" };
  }
  if (
    args.operationPaymentSessionId
    && String(args.operationPaymentSessionId).trim() !==
      String(args.claimedPaymentSessionId).trim()
  ) {
    return { ok: false, reason: "payment_session_mismatch" };
  }
  const claimedCcy = String(args.claimedCurrency ?? "GBP").toUpperCase();
  const gotCcy = String(args.retrievedCurrency ?? claimedCcy).toUpperCase();
  if (claimedCcy && gotCcy && claimedCcy !== gotCcy) {
    return { ok: false, reason: "currency_mismatch" };
  }
  if (!args.providerTerminal) {
    return { ok: false, reason: "provider_not_terminal" };
  }
  const confirmed = args.confirmedAmountPence;
  if (confirmed == null || !Number.isFinite(confirmed) || confirmed <= 0) {
    return { ok: false, reason: "no_confirmed_amount" };
  }
  // Confirmed may be partial; never invent full from requested alone.
  void args.requestedAmountPence;
  return { ok: true };
}
