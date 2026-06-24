import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export const PAYOUT_LEDGER_TYPES = [
  "WEEKLY_PAYOUT",
  "PAYOUT",
  "MANUAL_PAYOUT",
  "EARLY_CASHOUT",
] as const;

export type PayoutLedgerType = (typeof PAYOUT_LEDGER_TYPES)[number];

export function ledgerTypeForBatchKind(kind: string): PayoutLedgerType {
  if (kind === "EARLY_CASHOUT") return "EARLY_CASHOUT";
  if (kind === "WEEKLY_MONDAY") return "WEEKLY_PAYOUT";
  if (kind === "MANUAL_ADMIN" || kind === "CONNECT_MANUAL") return "MANUAL_PAYOUT";
  return "PAYOUT";
}

export function payoutDescriptionForType(type: PayoutLedgerType): string {
  if (type === "WEEKLY_PAYOUT") return "Weekly payout to bank";
  if (type === "MANUAL_PAYOUT") return "Manual payout to bank";
  if (type === "EARLY_CASHOUT") return "Early cash out";
  return "Payout to bank";
}

export type FinalizePayoutLedgerResult = {
  success: boolean;
  status: "completed" | "ledger_sync_failed" | "failed";
  ledgerEntryId: string | null;
  walletRecalculated: boolean;
  error: string | null;
  walletBalanceAfter: number | null;
};

export async function finalizePayoutAfterProviderSuccess(args: {
  supabase: SupabaseClient;
  payoutItemId: string;
  batchId: string;
  driverId: string;
  payoutAmount: number;
  currencyCode: string;
  batchKind: string;
  stripeTransferId: string | null;
  stripePayoutId: string | null;
  walletBalanceBefore: number;
}): Promise<FinalizePayoutLedgerResult> {
  const ledgerType = ledgerTypeForBatchKind(args.batchKind);

  const { data: ledgerEntry, error: ledgerError } = await args.supabase
    .from("driver_wallet_ledger")
    .insert({
      driver_id: args.driverId,
      type: ledgerType,
      amount_pence: -args.payoutAmount,
      currency: args.currencyCode,
      description: payoutDescriptionForType(ledgerType),
      stripe_transfer_id: args.stripeTransferId,
      stripe_payout_id: args.stripePayoutId,
    })
    .select("id")
    .single();

  if (ledgerError || !ledgerEntry?.id) {
    const errMsg = ledgerError?.message ?? "ledger_insert_failed";
    console.error("[payout] Ledger insert failed:", ledgerError);

    await args.supabase.from("payout_items").update({
      status: "ledger_sync_failed",
      stripe_transfer_id: args.stripeTransferId,
      stripe_payout_id: args.stripePayoutId,
      ledger_sync_error: errMsg,
      error_message: `Provider payout succeeded but ledger debit failed: ${errMsg}`,
      updated_at: new Date().toISOString(),
    }).eq("id", args.payoutItemId);

    await args.supabase.from("payout_batches").update({
      status: "partial",
      failed_payouts: 1,
      notes: `CRITICAL: Provider payout sent; ledger sync failed for item ${args.payoutItemId}`,
      updated_at: new Date().toISOString(),
    }).eq("id", args.batchId);

    return {
      success: false,
      status: "ledger_sync_failed",
      ledgerEntryId: null,
      walletRecalculated: false,
      error: errMsg,
      walletBalanceAfter: args.walletBalanceBefore,
    };
  }

  const { error: recalcError } = await args.supabase.rpc("recalculate_driver_wallet", {
    p_driver_id: args.driverId,
  });

  if (recalcError) {
    const errMsg = recalcError.message;
    console.error("[payout] Wallet recalc failed:", recalcError);

    await args.supabase.from("payout_items").update({
      status: "ledger_sync_failed",
      stripe_transfer_id: args.stripeTransferId,
      stripe_payout_id: args.stripePayoutId,
      ledger_entry_id: ledgerEntry.id,
      ledger_sync_error: errMsg,
      error_message: `Ledger debited but wallet recalc failed: ${errMsg}`,
      updated_at: new Date().toISOString(),
    }).eq("id", args.payoutItemId);

    return {
      success: false,
      status: "ledger_sync_failed",
      ledgerEntryId: ledgerEntry.id,
      walletRecalculated: false,
      error: errMsg,
      walletBalanceAfter: args.walletBalanceBefore,
    };
  }

  const completedAt = new Date().toISOString();
  const walletBalanceAfter = args.walletBalanceBefore - args.payoutAmount;

  await args.supabase.from("payout_items").update({
    status: "completed",
    stripe_transfer_id: args.stripeTransferId,
    stripe_payout_id: args.stripePayoutId,
    ledger_entry_id: ledgerEntry.id,
    wallet_recalculated_at: completedAt,
    ledger_sync_error: null,
    error_message: null,
    completed_at: completedAt,
    updated_at: completedAt,
  }).eq("id", args.payoutItemId);

  await args.supabase.from("payout_batches").update({
    status: "completed",
    successful_payouts: 1,
    failed_payouts: 0,
    completed_at: completedAt,
    updated_at: completedAt,
  }).eq("id", args.batchId);

  return {
    success: true,
    status: "completed",
    ledgerEntryId: ledgerEntry.id,
    walletRecalculated: true,
    error: null,
    walletBalanceAfter,
  };
}

export async function retryPayoutLedgerSync(
  supabase: SupabaseClient,
  payoutItemId: string,
): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.rpc("sync_payout_item_ledger_debit", {
    p_payout_item_id: payoutItemId,
  });
  if (error) throw error;
  return (data ?? {}) as Record<string, unknown>;
}
