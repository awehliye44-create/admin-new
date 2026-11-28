/** Offline test/audit-only helpers; not part of Edge uploads. */
import { EarningSettlementInput, isEarningPayableForPayout, remainingPayablePence } from "../../../functions/_shared/payoutEligibilitySSOT.ts";


/**
 * Provider-neutral cleared settlement batch total.
 * Rows carrying an explicit settlement_status only count when it is "settled".
 */
export function sumClearedSettlementBatchPence(
  earnings: EarningSettlementInput[],
): number {
  return earnings.reduce((sum, row) => {
    if (!isEarningPayableForPayout(row)) return sum;
    // Cash: settlement status can be pending — cashout consumes ledger "paid" rows elsewhere.
    const method = String((row as Record<string, unknown>).payment_method ?? "").toLowerCase();
    const isCash = method === "cash" || method.includes("cash");

    // Card / digital: must be settled and must have confirmed customer capture evidence.
    if (!isCash) {
      if (row.settlement_status != null && row.settlement_status !== "settled") return sum;

      // Captured only counts when payment_captured is explicitly true.
      if (row.payment_captured !== true) return sum;

      // For digital: captured amount must be present (>0). Do not invent from trips.capture.
      const captured = (row as Record<string, unknown>).captured_amount_pence as number | null | undefined;
      if (typeof captured !== "number" || !Number.isFinite(captured) || captured <= 0) return sum;
    }

    return sum + remainingPayablePence(row);
  }, 0);
}

export * from "../../../functions/_shared/payoutEligibilitySSOT.ts";
