import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  deriveSettlementStatus,
  formatProviderFailureReason,
} from "./mondayPayoutDiagnostics.ts";

export type PayoutSettlementSnapshot = {
  gross_payable_pence: number;
  cash_commission_recovered_pence: number;
  net_driver_payout_pence: number;
};

/** Commission recovered since run date (Monday settlement window). */
export async function computeCashCommissionRecoveredPence(
  supabase: SupabaseClient,
  driverId: string,
  sinceIso: string,
): Promise<number> {
  const { data: rows } = await supabase
    .from("driver_wallet_ledger")
    .select("type, amount_pence")
    .eq("driver_id", driverId)
    .eq("type", "DEBT_RECOVERY")
    .gte("created_at", sinceIso);

  return (rows ?? []).reduce((sum, row) => {
    return sum + Math.abs(Number(row.amount_pence ?? 0));
  }, 0);
}

export async function buildPayoutSettlementSnapshot(
  supabase: SupabaseClient,
  driverId: string,
  netDriverPayoutPence: number,
  runDateIso: string,
): Promise<PayoutSettlementSnapshot> {
  const sinceIso = `${runDateIso}T00:00:00.000Z`;
  const cashCommission = await computeCashCommissionRecoveredPence(
    supabase,
    driverId,
    sinceIso,
  );
  const grossPayable = netDriverPayoutPence + cashCommission;
  return {
    gross_payable_pence: grossPayable,
    cash_commission_recovered_pence: cashCommission,
    net_driver_payout_pence: netDriverPayoutPence,
  };
}

export async function recordPayoutFailureAndReturnToWallet(args: {
  supabase: SupabaseClient;
  payoutItemId: string;
  batchId: string;
  batchKind: string;
  driverId: string;
  netDriverPayoutPence: number;
  snapshot: PayoutSettlementSnapshot;
  providerStatus: string;
  providerReference: string | null;
  rawFailureReason: string | null;
  stripeTransferId?: string | null;
  stripePayoutId?: string | null;
}): Promise<{ success: boolean; error?: string; returned_pence?: number }> {
  const failureReason = formatProviderFailureReason(args.rawFailureReason);
  const failedAt = new Date().toISOString();
  const settlementStatus = deriveSettlementStatus({
    payoutStatus: "failed",
    cashCommissionRecoveredPence: args.snapshot.cash_commission_recovered_pence,
    driverPaidOutPence: 0,
    failedPayoutAmountPence: args.netDriverPayoutPence,
    returnedToWalletPence: 0,
    stripeTransferId: args.stripeTransferId,
    stripePayoutId: args.stripePayoutId,
  });

  await args.supabase.from("payout_items").update({
    status: "failed",
    settlement_status: settlementStatus,
    gross_payable_pence: args.snapshot.gross_payable_pence,
    cash_commission_recovered_pence: args.snapshot.cash_commission_recovered_pence,
    net_driver_payout_pence: args.netDriverPayoutPence,
    driver_paid_out_pence: 0,
    failed_payout_amount_pence: args.netDriverPayoutPence,
    provider_status: args.providerStatus,
    provider_reference: args.providerReference,
    failure_code: "PROVIDER_TRANSFER_FAILED",
    failure_reason: failureReason,
    provider_response: { raw: args.rawFailureReason },
    error_message: failureReason,
    failed_at: failedAt,
    stripe_transfer_id: args.stripeTransferId ?? null,
    stripe_payout_id: args.stripePayoutId ?? null,
    updated_at: failedAt,
  }).eq("id", args.payoutItemId);

  await args.supabase.from("payout_batches").update({
    status: "failed",
    successful_payouts: 0,
    failed_payouts: 1,
    failure_code: "PROVIDER_TRANSFER_FAILED",
    failure_reason: failureReason,
    provider_response: { raw: args.rawFailureReason },
    failed_at: failedAt,
    completed_at: failedAt,
    notes: settlementStatus === "PARTIAL_SETTLEMENT"
      ? "ONECAB commission was recovered, but driver payout did not complete."
      : `Driver payout failed: ${failureReason}`,
    updated_at: failedAt,
  }).eq("id", args.batchId);

  const { data: returnResult, error: returnError } = await args.supabase.rpc(
    "return_failed_payout_to_wallet",
    { p_payout_item_id: args.payoutItemId },
  );

  if (returnError) {
    console.error("[payout-failure] wallet return failed:", returnError);
    return { success: false, error: returnError.message };
  }

  const returned = Number(
    (returnResult as { returned_to_wallet_pence?: number })?.returned_to_wallet_pence ?? 0,
  );

  return { success: true, returned_pence: returned };
}

export async function recordPayoutSuccessDiagnostics(args: {
  supabase: SupabaseClient;
  payoutItemId: string;
  snapshot: PayoutSettlementSnapshot;
  netDriverPayoutPence: number;
  providerStatus: string;
  providerReference: string | null;
}): Promise<void> {
  await args.supabase.from("payout_items").update({
    settlement_status: "COMPLETE",
    gross_payable_pence: args.snapshot.gross_payable_pence,
    cash_commission_recovered_pence: args.snapshot.cash_commission_recovered_pence,
    net_driver_payout_pence: args.netDriverPayoutPence,
    driver_paid_out_pence: args.netDriverPayoutPence,
    failed_payout_amount_pence: 0,
    returned_to_wallet_pence: 0,
    provider_status: args.providerStatus,
    provider_reference: args.providerReference,
    failure_reason: null,
    failed_at: null,
    updated_at: new Date().toISOString(),
  }).eq("id", args.payoutItemId);
}
