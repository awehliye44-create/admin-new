import {
  invokeAutomatedPayoutCompletion,
  invokeManualExternalPayoutCompletion,
} from "./payoutCompletionRpcSSOT.ts";
import { redactCompletionEvidence } from "./driverPayoutCompletionSSOT.ts";
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
  if (type === "EARLY_CASHOUT") return "Withdrawal";
  return "Payout to bank";
}

export async function refreshPayoutBatchStatus(
  supabase: SupabaseClient,
  batchId: string,
): Promise<void> {
  const { data: items } = await supabase
    .from("payout_items")
    .select("status")
    .eq("batch_id", batchId);

  const rows = items ?? [];
  if (rows.length === 0) return;

  const completed = rows.filter((r) => r.status === "completed" || r.status === "COMPLETED").length;
  const failed = rows.filter((r) => ["failed", "ledger_sync_failed"].includes(String(r.status))).length;
  const now = new Date().toISOString();

  let status = "processing";
  if (completed === rows.length) status = "completed";
  else if (failed > 0 && completed === 0) status = "failed";
  else if (completed > 0 || failed > 0) status = "partial";

  await supabase.from("payout_batches").update({
    status,
    successful_payouts: completed,
    failed_payouts: failed,
    completed_at: completed === rows.length ? now : null,
    updated_at: now,
  }).eq("id", batchId);
}

export type FinalizePayoutLedgerResult = {
  success: boolean;
  status: "completed" | "ledger_sync_failed" | "failed";
  ledgerEntryId: string | null;
  walletRecalculated: boolean;
  error: string | null;
  walletBalanceAfter: number | null;
};

/** Path B — verified manual external bank transfer (single atomic RPC). */
export async function finalizeManualExternalPayout(args: {
  supabase: SupabaseClient;
  payoutItemId: string;
  batchId: string;
  driverId: string;
  payoutAmount: number;
  externalReference: string;
  adminUserId?: string | null;
  completedAt?: string | null;
  walletBalanceBefore: number;
}): Promise<FinalizePayoutLedgerResult> {
  const rpc = await invokeManualExternalPayoutCompletion({
    supabase: args.supabase,
    payoutItemId: args.payoutItemId,
    driverId: args.driverId,
    amountPence: args.payoutAmount,
    externalReference: args.externalReference,
    completedAt: args.completedAt,
    adminUserId: args.adminUserId,
    evidence: {
      path: "manual_external_bank_transfer",
      amount_pence: args.payoutAmount,
    },
  });

  if (!rpc.ok) {
    const errMsg = rpc.error ?? "manual_completion_failed";
    await args.supabase.from("payout_items").update({
      status: "ledger_sync_failed",
      ledger_sync_error: errMsg,
      error_message: `Manual payout completion failed: ${errMsg}`,
      updated_at: new Date().toISOString(),
    }).eq("id", args.payoutItemId);

    return {
      success: false,
      status: "ledger_sync_failed",
      ledgerEntryId: rpc.ledger_entry_id,
      walletRecalculated: rpc.wallet_debited,
      error: errMsg,
      walletBalanceAfter: args.walletBalanceBefore,
    };
  }

  await refreshPayoutBatchStatus(args.supabase, args.batchId);

  return {
    success: true,
    status: "completed",
    ledgerEntryId: rpc.ledger_entry_id,
    walletRecalculated: rpc.wallet_debited,
    error: null,
    walletBalanceAfter: args.walletBalanceBefore - args.payoutAmount,
  };
}

/** Path A — automated provider-completed payout (single finalize RPC, no TS prerequisite seeding). */
export async function finalizeAutomatedPayoutAfterProviderSuccess(args: {
  supabase: SupabaseClient;
  payoutItemId: string;
  batchId: string;
  driverId: string;
  payoutAmount: number;
  currencyCode: string;
  providerPaymentId: string;
  providerState?: string;
  providerCompletedAt?: string | null;
  walletBalanceBefore: number;
}): Promise<FinalizePayoutLedgerResult> {
  const payId = String(args.providerPaymentId ?? "").trim();
  if (!payId) {
    return {
      success: false,
      status: "failed",
      ledgerEntryId: null,
      walletRecalculated: false,
      error: "provider_payment_id_required",
      walletBalanceAfter: args.walletBalanceBefore,
    };
  }

  const completedAt = args.providerCompletedAt ?? new Date().toISOString();
  const rpc = await invokeAutomatedPayoutCompletion({
    supabase: args.supabase,
    payoutItemId: args.payoutItemId,
    providerPaymentId: payId,
    providerState: args.providerState ?? "completed",
    providerCompletedAt: completedAt,
    evidence: redactCompletionEvidence({
      provider_payment_id: payId,
      provider_state: "completed",
      completed_at: completedAt,
      amount_pence: args.payoutAmount,
      currency: args.currencyCode,
    }),
  });

  if (!rpc.ok) {
    const errMsg = rpc.error ?? "finalize_rpc_failed";
    await args.supabase.from("payout_items").update({
      status: "ledger_sync_failed",
      ledger_sync_error: errMsg,
      error_message: `Provider payout succeeded but completion RPC failed: ${errMsg}`,
      updated_at: new Date().toISOString(),
    }).eq("id", args.payoutItemId);

    await args.supabase.from("payout_batches").update({
      status: "partial",
      failed_payouts: 1,
      notes: `CRITICAL: Provider payout sent; completion RPC failed for item ${args.payoutItemId}`,
      updated_at: new Date().toISOString(),
    }).eq("id", args.batchId);

    return {
      success: false,
      status: "ledger_sync_failed",
      ledgerEntryId: rpc.ledger_entry_id,
      walletRecalculated: rpc.wallet_debited,
      error: errMsg,
      walletBalanceAfter: args.walletBalanceBefore,
    };
  }

  await refreshPayoutBatchStatus(args.supabase, args.batchId);

  return {
    success: true,
    status: "completed",
    ledgerEntryId: rpc.ledger_entry_id,
    walletRecalculated: rpc.wallet_debited,
    error: null,
    walletBalanceAfter: args.walletBalanceBefore - args.payoutAmount,
  };
}

/** @deprecated Use finalizeManualExternalPayout or finalizeAutomatedPayoutAfterProviderSuccess. */
export async function finalizePayoutAfterProviderSuccess(args: {
  supabase: SupabaseClient;
  payoutItemId: string;
  batchId: string;
  driverId: string;
  payoutAmount: number;
  currencyCode: string;
  batchKind: string;
  providerTransferId?: string | null;
  providerPayoutId?: string | null;
  providerReference?: string | null;
  paymentProvider?: string | null;
  walletBalanceBefore: number;
  adminUserId?: string | null;
}): Promise<FinalizePayoutLedgerResult> {
  const ref = args.providerReference?.trim()
    || args.providerPayoutId?.trim()
    || args.providerTransferId?.trim()
    || "";
  return finalizeManualExternalPayout({
    supabase: args.supabase,
    payoutItemId: args.payoutItemId,
    batchId: args.batchId,
    driverId: args.driverId,
    payoutAmount: args.payoutAmount,
    externalReference: ref,
    adminUserId: args.adminUserId,
    walletBalanceBefore: args.walletBalanceBefore,
  });
}

export async function retryPayoutLedgerSync(
  supabase: SupabaseClient,
  payoutItemId: string,
): Promise<Record<string, unknown>> {
  const { data: item } = await supabase
    .from("payout_items")
    .select("id, provider_reference, provider_payout_id, provider_transfer_id, batch_id")
    .eq("id", payoutItemId)
    .maybeSingle();

  const providerPaymentId = String(
    item?.provider_payout_id ?? item?.provider_reference ?? item?.provider_transfer_id ?? "",
  ).trim();

  if (!providerPaymentId) {
    throw new Error("missing_provider_reference_for_completion_retry");
  }

  const rpc = await invokeAutomatedPayoutCompletion({
    supabase,
    payoutItemId,
    providerPaymentId,
    providerState: "completed",
  });

  if (!rpc.ok) {
    throw new Error(rpc.error ?? "finalize_driver_payout_completion_failed");
  }

  if (item?.batch_id) {
    await refreshPayoutBatchStatus(supabase, String(item.batch_id));
  }

  return {
    success: true,
    ledger_entry_id: rpc.ledger_entry_id,
    already_applied: rpc.already_applied ?? false,
    wallet_debited: rpc.wallet_debited,
  };
}
