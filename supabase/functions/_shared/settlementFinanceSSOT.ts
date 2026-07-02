/**
 * Finance-cleared amounts from driver_earning_settlement — never max(wallet, 0).
 */
import {
  sumEligibleEarningPence,
  type EarningSettlementInput,
} from "./payoutEligibilitySSOT.ts";
import { sumIncludedInPayoutBatchPence } from "./driverWalletPayoutSSOT.ts";

export type SettlementRow = {
  id?: string;
  trip_id?: string | null;
  settlement_status?: string | null;
  allocated_to_payout?: boolean | null;
  allocated_amount_pence?: number | null;
  paid_in_batch_id?: string | null;
  paid_in_payout_item_id?: string | null;
  driver_wallet_ledger?: { amount_pence?: number } | { amount_pence?: number }[] | null;
};

export function mapSettlementRowsToEarningInputs(
  settlements: SettlementRow[],
): EarningSettlementInput[] {
  return settlements.map((s) => {
    const ledgerJoin = s.driver_wallet_ledger;
    const ledgerAmt = Array.isArray(ledgerJoin)
      ? Number(ledgerJoin[0]?.amount_pence ?? 0)
      : Number(ledgerJoin?.amount_pence ?? 0);
    const st = String(s.settlement_status ?? "").toLowerCase();
    return {
      amount_pence: Math.max(0, ledgerAmt),
      settlement_status: st === "settled" ? "settled" : st === "failed" ? "failed" : "pending",
      paid_in_batch_id: s.paid_in_batch_id as string | null,
      allocated_to_payout: s.allocated_to_payout === true,
      allocated_amount_pence: Number(s.allocated_amount_pence ?? 0),
      trip_completed: true,
      payment_captured: true,
      payment_method: "card",
    };
  });
}

export function computeFinanceClearedPenceFromSettlements(
  settlements: SettlementRow[],
): number {
  return sumEligibleEarningPence(mapSettlementRowsToEarningInputs(settlements));
}

export function computeIncludedInPayoutBatchPence(
  items: Array<{ status: string; net_driver_payout_pence?: number | null; amount_pence?: number | null }>,
): number {
  return sumIncludedInPayoutBatchPence(items);
}
