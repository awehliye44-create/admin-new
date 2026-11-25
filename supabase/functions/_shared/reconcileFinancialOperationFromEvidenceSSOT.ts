/**
 * #92G — Reconcile financial_operations from provider/PSA evidence without POST.
 *
 * INCREMENT rows must not remain INCREMENT_UNKNOWN after PSA (or order retrieve)
 * has confirmed coverage. Capture/settlement paths call this as evidence-only.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { isTerminalFinancialOpState } from "./paymentFinancialOperationSSOT.ts";
import { completeFinancialOperationFromProvider } from "./paymentFinancialOperationPersistSSOT.ts";
import { recordPaymentFinancialEvent } from "./paymentFinancialDiagnosticsSSOT.ts";

const RECONCILABLE_INCREMENT_STATES = new Set([
  "INCREMENT_REQUESTED",
  "INCREMENT_PENDING",
  "INCREMENT_UNKNOWN",
]);

function nonNeg(v: unknown): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Flip matching INCREMENT ops to COVER_CONFIRMED when target coverage is confirmed.
 * Never POSTs. Never invents amounts — confirmedAmountPence must be provider-authoritative.
 */
export async function reconcileIncrementOperationsToCoverConfirmed(
  supabase: SupabaseClient,
  args: {
    tripId: string;
    paymentSessionId: string;
    providerOrderId: string;
    targetAmountPence: number;
    confirmedAmountPence: number;
    reason: string;
  },
): Promise<{ updated: number }> {
  const target = nonNeg(args.targetAmountPence);
  const confirmed = nonNeg(args.confirmedAmountPence);
  if (target <= 0 || confirmed < target) return { updated: 0 };

  const { data: rows } = await supabase
    .from("payment_financial_operations")
    .select("id, fence, state, execution_id, requested_amount_pence, logical_idempotency_key")
    .eq("payment_session_id", args.paymentSessionId)
    .eq("op_type", "INCREMENT")
    .eq("provider_order_id", args.providerOrderId)
    .eq("requested_amount_pence", target);

  let updated = 0;
  for (const row of rows ?? []) {
    const state = String(row.state ?? "");
    if (isTerminalFinancialOpState(state) && state === "COVER_CONFIRMED") continue;
    if (!RECONCILABLE_INCREMENT_STATES.has(state) && state !== "COVER_CONFIRMED") {
      // Decline/failed terminal — leave alone.
      if (isTerminalFinancialOpState(state)) continue;
    }
    if (!RECONCILABLE_INCREMENT_STATES.has(state)) continue;

    await completeFinancialOperationFromProvider(supabase, {
      operationId: String(row.id),
      fence: String(row.fence),
      state: "COVER_CONFIRMED",
      confirmedAmountPence: confirmed,
    });
    await recordPaymentFinancialEvent(supabase, {
      paymentSessionId: args.paymentSessionId,
      tripId: args.tripId,
      operationId: String(row.id),
      executionId: String(row.execution_id ?? ""),
      fence: String(row.fence),
      opType: "INCREMENT",
      eventType: "evidence_reconciled",
      requestedAmountPence: target,
      providerConfirmedAmountPence: confirmed,
      providerResponseState: "COVER_CONFIRMED",
      idempotencyReference: String(row.logical_idempotency_key ?? ""),
      detail: { reason: args.reason, prior_state: state },
    }).catch(() => undefined);
    updated += 1;
  }
  return { updated };
}
