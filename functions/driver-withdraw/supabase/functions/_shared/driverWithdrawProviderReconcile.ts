/**
 * Read-only provider status sync → idempotent finalize_driver_payout_completion.
 * Never calls Revolut /pay. Never fabricates completed.
 */
import {
  relayApprovedDriverPayoutPaymentStatus,
} from "./revolutBusinessRelayClient.ts";
import { ensureFreshRevolutBusinessAccessToken } from "./revolutBusinessAccessTokenRefresh.ts";
import { maskProviderId, redactProviderEvidence } from "./driverPayoutSubmissionSSOT.ts";

export type ReconcileSubmittedPayoutResult = {
  ok: boolean;
  payout_item_id: string;
  provider_payment_id: string | null;
  provider_payment_id_masked: string | null;
  provider_state: string | null;
  previous_provider_state: string | null;
  revolut_pay_called: false;
  wallet_debited: boolean;
  reservation_consumed: boolean;
  item_status: string | null;
  financially_applied: boolean;
  already_applied: boolean;
  error?: string;
  message?: string;
};

// deno-lint-ignore no-explicit-any
type SupabaseClientLike = any;

/**
 * Sync Revolut GET /transaction/:id for a SUBMITTED EARLY_CASHOUT item.
 * If provider_state === completed, call finalize_driver_payout_completion once.
 */
export async function reconcileSubmittedDriverWithdrawPayout(args: {
  supabase: SupabaseClientLike;
  payoutItemId: string;
  /** When set, reject if item.driver_id mismatches (driver-auth path). */
  expectedDriverId?: string;
}): Promise<ReconcileSubmittedPayoutResult> {
  const payoutItemId = args.payoutItemId;

  const { data: item } = await args.supabase
    .from("payout_items")
    .select("id, status, amount_pence, driver_id, completed_at, batch_id")
    .eq("id", payoutItemId)
    .maybeSingle();

  if (!item?.id) {
    return {
      ok: false,
      payout_item_id: payoutItemId,
      provider_payment_id: null,
      provider_payment_id_masked: null,
      provider_state: null,
      previous_provider_state: null,
      revolut_pay_called: false,
      wallet_debited: false,
      reservation_consumed: false,
      item_status: null,
      financially_applied: false,
      already_applied: false,
      error: "PAYOUT_ITEM_NOT_FOUND",
      message: "Withdrawal item not found.",
    };
  }

  if (args.expectedDriverId && String(item.driver_id) !== args.expectedDriverId) {
    return {
      ok: false,
      payout_item_id: payoutItemId,
      provider_payment_id: null,
      provider_payment_id_masked: null,
      provider_state: null,
      previous_provider_state: null,
      revolut_pay_called: false,
      wallet_debited: false,
      reservation_consumed: false,
      item_status: String(item.status ?? ""),
      financially_applied: false,
      already_applied: false,
      error: "DRIVER_MISMATCH",
      message: "Withdrawal does not belong to this driver.",
    };
  }

  const { data: batch } = await args.supabase
    .from("payout_batches")
    .select("kind")
    .eq("id", item.batch_id)
    .maybeSingle();
  if (String(batch?.kind ?? "") !== "EARLY_CASHOUT") {
    return {
      ok: false,
      payout_item_id: payoutItemId,
      provider_payment_id: null,
      provider_payment_id_masked: null,
      provider_state: null,
      previous_provider_state: null,
      revolut_pay_called: false,
      wallet_debited: false,
      reservation_consumed: false,
      item_status: String(item.status ?? ""),
      financially_applied: false,
      already_applied: false,
      error: "NOT_EARLY_CASHOUT",
      message: "Only Driver Withdraw items can be reconciled here.",
    };
  }

  const { data: intent } = await args.supabase
    .from("driver_payout_payment_intents")
    .select(
      "id, provider_payment_id, provider_state, execution_status, financially_applied_at",
    )
    .eq("payout_item_id", payoutItemId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const previousState = intent?.provider_state
    ? String(intent.provider_state)
    : null;
  const providerPaymentId = intent?.provider_payment_id
    ? String(intent.provider_payment_id)
    : null;

  if (intent?.financially_applied_at) {
    return {
      ok: true,
      payout_item_id: payoutItemId,
      provider_payment_id: providerPaymentId,
      provider_payment_id_masked: maskProviderId(providerPaymentId),
      provider_state: previousState ?? "completed",
      previous_provider_state: previousState,
      revolut_pay_called: false,
      wallet_debited: true,
      reservation_consumed: true,
      item_status: String(item.status ?? "COMPLETED"),
      financially_applied: true,
      already_applied: true,
    };
  }

  if (!providerPaymentId) {
    return {
      ok: false,
      payout_item_id: payoutItemId,
      provider_payment_id: null,
      provider_payment_id_masked: null,
      provider_state: previousState,
      previous_provider_state: previousState,
      revolut_pay_called: false,
      wallet_debited: false,
      reservation_consumed: false,
      item_status: String(item.status ?? ""),
      financially_applied: false,
      already_applied: false,
      error: "MISSING_PROVIDER_PAYMENT_ID",
      message: "No provider payment id to reconcile.",
    };
  }

  let accessToken: string;
  try {
    const tok = await ensureFreshRevolutBusinessAccessToken(args.supabase);
    accessToken = tok.accessToken;
  } catch (err) {
    return {
      ok: false,
      payout_item_id: payoutItemId,
      provider_payment_id: providerPaymentId,
      provider_payment_id_masked: maskProviderId(providerPaymentId),
      provider_state: previousState,
      previous_provider_state: previousState,
      revolut_pay_called: false,
      wallet_debited: false,
      reservation_consumed: false,
      item_status: String(item.status ?? ""),
      financially_applied: false,
      already_applied: false,
      error: "ACCESS_TOKEN_REQUIRED",
      message: err instanceof Error ? err.message : "access token unavailable",
    };
  }

  const statusRes = await relayApprovedDriverPayoutPaymentStatus({
    providerPaymentId,
    payoutItemId,
    accessToken,
  });

  const liveState = statusRes.provider_state
    ? String(statusRes.provider_state).toLowerCase()
    : null;

  // Persist latest provider sync (read-only; does not debit).
  await args.supabase
    .from("driver_payout_payment_intents")
    .update({
      provider_state: liveState ?? previousState,
      last_provider_sync_at: new Date().toISOString(),
      provider_completed_at: liveState === "completed"
        ? (statusRes.completed_at ?? new Date().toISOString())
        : null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", intent.id);

  if (statusRes.status < 200 || statusRes.status >= 300 || !liveState) {
    return {
      ok: false,
      payout_item_id: payoutItemId,
      provider_payment_id: providerPaymentId,
      provider_payment_id_masked: maskProviderId(providerPaymentId),
      provider_state: liveState ?? previousState,
      previous_provider_state: previousState,
      revolut_pay_called: false,
      wallet_debited: false,
      reservation_consumed: false,
      item_status: String(item.status ?? ""),
      financially_applied: false,
      already_applied: false,
      error: statusRes.error ?? "PROVIDER_STATUS_UNAVAILABLE",
      message: "Could not read provider payment status.",
    };
  }

  if (liveState !== "completed") {
    return {
      ok: true,
      payout_item_id: payoutItemId,
      provider_payment_id: providerPaymentId,
      provider_payment_id_masked: maskProviderId(providerPaymentId),
      provider_state: liveState,
      previous_provider_state: previousState,
      revolut_pay_called: false,
      wallet_debited: false,
      reservation_consumed: false,
      item_status: String(item.status ?? ""),
      financially_applied: false,
      already_applied: false,
      message: `Provider state is ${liveState}; completion deferred until completed.`,
    };
  }

  const evidence = redactProviderEvidence({
    provider_payment_id: providerPaymentId,
    provider_state: liveState,
    provider_request_id: null,
    http_status: statusRes.status,
    created_at: statusRes.created_at,
    failure_code: null,
  });

  const { data: completionRaw } = await args.supabase.rpc(
    "finalize_driver_payout_completion",
    {
      p_payout_item_id: payoutItemId,
      p_provider_payment_id: providerPaymentId,
      p_provider_state: liveState,
      p_provider_completed_at: statusRes.completed_at ?? new Date().toISOString(),
      p_evidence_redacted: {
        ...evidence,
        reconciled_via: "driver_withdraw_provider_status",
        revolut_pay_called: false,
      },
    },
  );
  const completion = (completionRaw ?? {}) as Record<string, unknown>;
  const applied = completion.ok === true;

  return {
    ok: applied,
    payout_item_id: payoutItemId,
    provider_payment_id: providerPaymentId,
    provider_payment_id_masked: maskProviderId(providerPaymentId),
    provider_state: liveState,
    previous_provider_state: previousState,
    revolut_pay_called: false,
    wallet_debited: applied && completion.wallet_debited !== false,
    reservation_consumed: applied && completion.reservation_consumed !== false,
    item_status: applied
      ? String(completion.item_status ?? "COMPLETED")
      : String(item.status ?? ""),
    financially_applied: applied,
    already_applied: completion.already_applied === true,
    error: applied ? undefined : String(completion.error ?? "COMPLETION_FAILED"),
    message: applied
      ? undefined
      : String(completion.message ?? "Completion finalization failed."),
  };
}
