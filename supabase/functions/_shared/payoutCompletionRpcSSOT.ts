/**
 * Phase 0b — payout completion writers (automated vs manual external).
 * No multi-step TypeScript prerequisite seeding. Manual path uses atomic RPC only.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  isCanonicalProviderCompleted,
  redactCompletionEvidence,
} from "./driverPayoutCompletionSSOT.ts";

export type InvokeFinalizePayoutCompletionResult = {
  ok: boolean;
  already_applied?: boolean;
  ledger_entry_id: string | null;
  wallet_debited: boolean;
  reservation_consumed: boolean;
  error: string | null;
  error_code: string | null;
  raw: Record<string, unknown>;
};

export type AutomatedPayoutCompletionInput = {
  supabase: SupabaseClient;
  payoutItemId: string;
  providerPaymentId: string;
  providerState: string;
  providerCompletedAt?: string | null;
  evidence?: Record<string, unknown>;
};

export type ManualExternalPayoutCompletionInput = {
  supabase: SupabaseClient;
  payoutItemId: string;
  driverId: string;
  amountPence: number;
  externalReference: string;
  completedAt?: string | null;
  adminUserId?: string | null;
  operatorReason?: string | null;
  evidence?: Record<string, unknown>;
};

function mapRpcResult(result: Record<string, unknown>): InvokeFinalizePayoutCompletionResult {
  if (result.ok === false) {
    return {
      ok: false,
      ledger_entry_id: null,
      wallet_debited: false,
      reservation_consumed: false,
      error: String(result.message ?? result.error ?? "completion_failed"),
      error_code: String(result.error ?? "COMPLETION_FAILED"),
      raw: result,
    };
  }
  return {
    ok: true,
    already_applied: result.already_applied === true || result.reused === true || result.idempotent === true,
    ledger_entry_id: result.ledger_entry_id != null ? String(result.ledger_entry_id) : null,
    wallet_debited: result.wallet_debited === true,
    reservation_consumed: result.reservation_consumed === true,
    error: null,
    error_code: null,
    raw: result,
  };
}

/** Path A — automated payout: existing item + reservation + provider-completed evidence only. */
export async function invokeAutomatedPayoutCompletion(
  args: AutomatedPayoutCompletionInput,
): Promise<InvokeFinalizePayoutCompletionResult> {
  const payId = String(args.providerPaymentId ?? "").trim();
  const state = String(args.providerState ?? "").trim().toLowerCase();

  if (!payId) {
    return {
      ok: false,
      ledger_entry_id: null,
      wallet_debited: false,
      reservation_consumed: false,
      error: "provider_payment_id required",
      error_code: "MISSING_PROVIDER_PAYMENT_ID",
      raw: {},
    };
  }

  if (!isCanonicalProviderCompleted(state)) {
    return {
      ok: false,
      ledger_entry_id: null,
      wallet_debited: false,
      reservation_consumed: false,
      error: `provider state '${state || "unknown"}' is not completed — refuse completion`,
      error_code: "PROVIDER_NOT_COMPLETED",
      raw: {},
    };
  }

  const { data: item } = await args.supabase
    .from("payout_items")
    .select("id, driver_id, status, amount_pence")
    .eq("id", args.payoutItemId)
    .maybeSingle();

  if (!item?.id) {
    return {
      ok: false,
      ledger_entry_id: null,
      wallet_debited: false,
      reservation_consumed: false,
      error: "payout item not found",
      error_code: "PAYOUT_ITEM_NOT_FOUND",
      raw: {},
    };
  }

  const { data: reservation } = await args.supabase
    .from("driver_payout_reservations")
    .select("id, status")
    .eq("payout_item_id", args.payoutItemId)
    .in("status", ["ACTIVE", "CONSUMED"])
    .maybeSingle();

  if (!reservation?.id) {
    return {
      ok: false,
      ledger_entry_id: null,
      wallet_debited: false,
      reservation_consumed: false,
      error: "no active reservation — automated completion requires prior reserve",
      error_code: "RESERVATION_NOT_ACTIVE",
      raw: {},
    };
  }

  const { data: intent } = await args.supabase
    .from("driver_payout_payment_intents")
    .select("id, provider_payment_id, provider_state, execution_status")
    .eq("payout_item_id", args.payoutItemId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!intent?.id || !intent.provider_payment_id) {
    return {
      ok: false,
      ledger_entry_id: null,
      wallet_debited: false,
      reservation_consumed: false,
      error: "payment intent not submitted — cannot finalize automated transfer",
      error_code: "PAYOUT_ITEM_NOT_SUBMITTED",
      raw: {},
    };
  }

  const evidence = args.evidence ?? redactCompletionEvidence({
    provider_payment_id: payId,
    provider_state: "completed",
    completed_at: args.providerCompletedAt ?? new Date().toISOString(),
  });

  const { data: finalized, error: finalizeErr } = await args.supabase.rpc(
    "finalize_driver_payout_completion",
    {
      p_payout_item_id: args.payoutItemId,
      p_provider_payment_id: payId,
      p_provider_state: "completed",
      p_provider_completed_at: args.providerCompletedAt ?? new Date().toISOString(),
      p_evidence_redacted: evidence,
    },
  );

  if (finalizeErr) {
    return {
      ok: false,
      ledger_entry_id: null,
      wallet_debited: false,
      reservation_consumed: false,
      error: finalizeErr.message,
      error_code: "FINALIZE_RPC_ERROR",
      raw: {},
    };
  }

  return mapRpcResult((finalized ?? {}) as Record<string, unknown>);
}

/** Path B — verified manual external transfer: single atomic RPC (no TS prerequisite sequence). */
export async function invokeManualExternalPayoutCompletion(
  args: ManualExternalPayoutCompletionInput,
): Promise<InvokeFinalizePayoutCompletionResult> {
  const ref = String(args.externalReference ?? "").trim();
  if (!ref) {
    return {
      ok: false,
      ledger_entry_id: null,
      wallet_debited: false,
      reservation_consumed: false,
      error: "external_reference required",
      error_code: "MISSING_EXTERNAL_REFERENCE",
      raw: {},
    };
  }

  const { data: finalized, error: rpcErr } = await args.supabase.rpc(
    "finalize_manual_external_payout_completion",
    {
      p_payout_item_id: args.payoutItemId,
      p_external_reference: ref,
      p_driver_id: args.driverId,
      p_amount_pence: args.amountPence,
      p_completed_at: args.completedAt ?? new Date().toISOString(),
      p_admin_user_id: args.adminUserId ?? null,
      p_operator_reason: args.operatorReason ?? "admin_manual_bank_transfer",
      p_evidence: args.evidence ?? {},
    },
  );

  if (rpcErr) {
    return {
      ok: false,
      ledger_entry_id: null,
      wallet_debited: false,
      reservation_consumed: false,
      error: rpcErr.message,
      error_code: "MANUAL_COMPLETION_RPC_ERROR",
      raw: {},
    };
  }

  return mapRpcResult((finalized ?? {}) as Record<string, unknown>);
}

/** @deprecated Use invokeAutomatedPayoutCompletion or invokeManualExternalPayoutCompletion. */
export async function invokeFinalizeDriverPayoutCompletion(args: {
  supabase: SupabaseClient;
  payoutItemId: string;
  providerPaymentId: string;
  providerCompletedAt?: string | null;
  evidence?: Record<string, unknown>;
}): Promise<InvokeFinalizePayoutCompletionResult> {
  return invokeAutomatedPayoutCompletion({
    supabase: args.supabase,
    payoutItemId: args.payoutItemId,
    providerPaymentId: args.providerPaymentId,
    providerState: "completed",
    providerCompletedAt: args.providerCompletedAt,
    evidence: args.evidence,
  });
}
