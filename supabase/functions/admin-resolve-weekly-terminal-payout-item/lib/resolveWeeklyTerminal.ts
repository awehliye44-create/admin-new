/**
 * P7 M3 — per-item resolution of a weekly payout item stranded by a provider terminal failure.
 *
 * Order (never reordered):
 *   1. GET-reconcile first (read-only provider status → finalize if actually completed).
 *   2. Only if the provider STILL reports a terminal failure → fail_submitted_weekly_payout_item
 *      (fails ONE item, releases ONE reservation; other batch items untouched).
 *   3. Anything else (completed / pending / read failure) → no mutation by this function.
 * Never calls Revolut /pay, never resends, never writes the ledger directly.
 */
import { reconcileSubmittedDriverWithdrawPayout } from "../../_shared/driverWithdrawProviderReconcile.ts";
import {
  FAIL_SUBMITTED_WEEKLY_PAYOUT_ITEM_RPC,
  WEEKLY_PAYOUT_BATCH_KINDS,
  WEEKLY_TERMINAL_FAILURE_REPORT_ONLY_ERROR,
} from "../../_shared/payoutReconcileKindsSSOT.ts";
import { isEarlyCashoutProviderTerminalFailure } from "../../_shared/earlyCashoutInvariantSSOT.ts";
import { redactProviderEvidence } from "../../_shared/driverPayoutSubmissionSSOT.ts";

// deno-lint-ignore no-explicit-any
type SupabaseClientLike = any;

export type ResolveWeeklyTerminalOutcome =
  | "FAILED_AND_RELEASED"
  | "ALREADY_RESOLVED"
  | "RECONCILED_COMPLETED"
  | "NOT_TERMINAL"
  | "NOT_RESOLVED";

export type ResolveWeeklyTerminalResult = {
  ok: boolean;
  outcome: ResolveWeeklyTerminalOutcome;
  payout_item_id: string;
  provider_state: string | null;
  revolut_pay_called: false;
  reconcile_called: true;
  reservation_released: boolean;
  error?: string;
  message?: string;
};

export type ResolveWeeklyTerminalDeps = {
  reconcile?: typeof reconcileSubmittedDriverWithdrawPayout;
};

export async function resolveWeeklyTerminalPayoutItem(args: {
  supabase: SupabaseClientLike;
  payoutItemId: string;
  actorUserId: string | null;
  deps?: ResolveWeeklyTerminalDeps;
}): Promise<ResolveWeeklyTerminalResult> {
  const base = {
    payout_item_id: args.payoutItemId,
    revolut_pay_called: false as const,
    reconcile_called: true as const,
  };

  // 1) GET-reconcile first (weekly kinds only).
  const reconcile = args.deps?.reconcile ?? reconcileSubmittedDriverWithdrawPayout;
  const rec = await reconcile({
    supabase: args.supabase,
    payoutItemId: args.payoutItemId,
    allowedBatchKinds: WEEKLY_PAYOUT_BATCH_KINDS,
  });

  if (rec.ok && rec.financially_applied) {
    return {
      ...base,
      ok: true,
      outcome: rec.already_applied ? "ALREADY_RESOLVED" : "RECONCILED_COMPLETED",
      provider_state: rec.provider_state,
      reservation_released: false,
      message: "Provider reports the payout completed; reconciled without failing or releasing.",
    };
  }

  const state = rec.provider_state ? String(rec.provider_state).toLowerCase() : null;
  const stillTerminal = rec.error === WEEKLY_TERMINAL_FAILURE_REPORT_ONLY_ERROR &&
    !!state && isEarlyCashoutProviderTerminalFailure(state);

  if (!stillTerminal) {
    return {
      ...base,
      ok: false,
      outcome: rec.ok ? "NOT_TERMINAL" : "NOT_RESOLVED",
      provider_state: state,
      reservation_released: false,
      error: rec.error ?? "PROVIDER_NOT_TERMINAL_FAILED",
      message: rec.message ?? "Provider has not confirmed a terminal failure; nothing was changed.",
    };
  }

  // 2) Still terminal after the fresh GET → fail ONE item + release ONE reservation.
  const providerPaymentId = rec.provider_payment_id;
  if (!providerPaymentId) {
    return {
      ...base,
      ok: false,
      outcome: "NOT_RESOLVED",
      provider_state: state,
      reservation_released: false,
      error: "MISSING_PROVIDER_PAYMENT_ID",
    };
  }

  const { data: failRaw, error: rpcError } = await args.supabase.rpc(
    FAIL_SUBMITTED_WEEKLY_PAYOUT_ITEM_RPC,
    {
      p_payout_item_id: args.payoutItemId,
      p_provider_payment_id: providerPaymentId,
      p_provider_state: state,
      p_evidence_redacted: {
        ...redactProviderEvidence({
          provider_payment_id: providerPaymentId,
          provider_state: state,
          provider_request_id: null,
          http_status: null,
          created_at: null,
          failure_code: `PROVIDER_${String(state).toUpperCase()}`,
        }),
        reconciled_via: "admin_resolve_weekly_terminal_payout_item",
        revolut_pay_called: false,
      },
      p_actor_user_id: args.actorUserId,
    },
  );
  const fail = (failRaw ?? {}) as Record<string, unknown>;
  if (rpcError || fail.ok !== true) {
    return {
      ...base,
      ok: false,
      outcome: "NOT_RESOLVED",
      provider_state: state,
      reservation_released: false,
      error: String(fail.error ?? rpcError?.message ?? "WEEKLY_FAIL_RPC_FAILED"),
    };
  }
  return {
    ...base,
    ok: true,
    outcome: fail.idempotent === true ? "ALREADY_RESOLVED" : "FAILED_AND_RELEASED",
    provider_state: state,
    reservation_released: fail.reservation_released === true,
    message: "Weekly payout item failed and its reservation released; other batch items untouched; no resend.",
  };
}
