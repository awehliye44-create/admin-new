/**
 * Authoritative TRIP_EARNING_NET readback for post-capture wallet reconciliation.
 */
// Minimal structural client type — avoids remote type imports in shared builds.
// deno-lint-ignore no-explicit-any
type SupabaseClient = { from: (table: string) => any };


import {
  postingBalanced,
  postingWalletMismatch,
  type PostCaptureSettlementResult,
} from "./postCaptureSettlementResult.ts";

export type TripEarningNetLedgerReadback = {
  count: number;
  totalPence: number;
  rows: Array<{ id: string; amount_pence: number }>;
};

export async function readTripEarningNetLedgerState(
  supabase: SupabaseClient,
  tripId: string,
): Promise<TripEarningNetLedgerReadback> {
  const { data, error } = await supabase
    .from("driver_wallet_ledger")
    .select("id, amount_pence")
    .eq("related_trip_id", tripId)
    .eq("type", "TRIP_EARNING_NET");

  if (error) {
    throw error;
  }

  const rows = (Array.isArray(data) ? data : []).map((row) => ({
    id: String((row as { id: unknown }).id),
    amount_pence: Math.max(0, Math.round(Number((row as { amount_pence: unknown }).amount_pence) || 0)),
  }));

  return {
    count: rows.length,
    totalPence: rows.reduce((sum, row) => sum + row.amount_pence, 0),
    rows,
  };
}

export type TripEarningNetReconcileFailureStage =
  | "WALLET_CREDIT_MISSING"
  | "DUPLICATE_WALLET_CREDIT"
  | "WALLET_AMOUNT_MISMATCH";

export function reconcileTripEarningNetLedgerReadback(args: {
  expectedPence: number;
  readback: TripEarningNetLedgerReadback;
  settlementSucceeded?: boolean;
}): PostCaptureSettlementResult & { failureStage?: TripEarningNetReconcileFailureStage } {
  const expected = Math.max(0, Math.round(Number(args.expectedPence) || 0));
  const settlementStatus = args.settlementSucceeded === false ? "FAILED" : "SUCCEEDED";
  const { count, totalPence } = args.readback;

  if (count === 0) {
    return {
      ...postingWalletMismatch({
        settlement_status: settlementStatus,
        expectedPence: expected,
        postedPence: 0,
      }),
      failureStage: "WALLET_CREDIT_MISSING",
    };
  }
  if (count > 1) {
    return {
      ...postingWalletMismatch({
        settlement_status: settlementStatus,
        expectedPence: expected,
        postedPence: totalPence,
      }),
      failureStage: "DUPLICATE_WALLET_CREDIT",
    };
  }
  if (totalPence !== expected) {
    return {
      ...postingWalletMismatch({
        settlement_status: settlementStatus,
        expectedPence: expected,
        postedPence: totalPence,
      }),
      failureStage: "WALLET_AMOUNT_MISMATCH",
    };
  }
  return postingBalanced(expected, totalPence);
}
