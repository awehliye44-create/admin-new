/** Offline test/audit-only helpers; not part of Edge uploads. */
/**
 * #93B / #98 — TRIP_EARNING_PENDING → RELEASE → TEN.
 *
 * PENDING = earned net fare awaiting payment confirmation (not withdrawable, no clearing).
 * RELEASE = append-only offset before confirmed TEN (never DELETE PENDING).
 * Tip stays DRIVER_TIP_CREDIT after capture only.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";

import { tripBlocksDriverWalletLedgerPosting } from "../../../functions/_shared/commissionWalletDeduction.ts";

import { FINANCIAL_MODEL_VIOLATION } from "../../../functions/_shared/commissionWalletSSOT.ts";

import { recordPaymentFinancialEvent } from "../../../functions/_shared/paymentFinancialDiagnosticsSSOT.ts";
import { TRIP_EARNING_PENDING_TYPE, TRIP_EARNING_PENDING_RELEASE_TYPE } from "../../../functions/_shared/tripEarningPendingSSOT.ts";


/** Prefer TEN amount for trip display; else open PENDING (no RELEASE yet). */
export function resolveVisibleTripEarningPence(rows: Array<{
  type?: string | null;
  amount_pence?: number | null;
}>): { amountPence: number; state: "confirmed" | "awaiting_confirmation" | "none" } {
  let ten = 0;
  let pending = 0;
  let released = 0;
  for (const row of rows) {
    const type = String(row.type ?? "").toUpperCase();
    const amt = Math.round(Number(row.amount_pence) || 0);
    if (type === "TRIP_EARNING_NET") ten += Math.max(0, amt);
    else if (type === TRIP_EARNING_PENDING_TYPE) pending += Math.max(0, amt);
    else if (type === TRIP_EARNING_PENDING_RELEASE_TYPE) released += Math.abs(amt);
  }
  if (ten > 0) return { amountPence: ten, state: "confirmed" };
  if (pending > 0 && released <= 0) {
    return { amountPence: pending, state: "awaiting_confirmation" };
  }
  return { amountPence: 0, state: "none" };
}

export * from "../../../functions/_shared/tripEarningPendingSSOT.ts";
