/**
 * Revolut booking preauth SSOT — AUTHORISE only at booking; capture at trip completion.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  cancelRevolutOrder,
  captureRevolutOrder,
  mapRevolutStateToPaymentStatus,
  refundRevolutOrder,
  retrieveRevolutOrder,
} from "./revolutOrders.ts";
import { resolveRevolutMerchantContext } from "./revolutMerchantContext.ts";
import { markPaymentSessionReleased, markPaymentSessionProviderFee } from "./paymentSessionSSOT.ts";
import { extractProviderFeePence } from "./paymentCaptureEvidenceSSOT.ts";
import {
  buildFeeCapturePaymentSessionPatch,
  isChargedFeeOutcome,
  isNonCompletedTerminalTripStatus,
} from "./chargedTerminalFeeWalletSSOT.ts";

export type RevolutHoldReconciliationStatus =
  | "authorised_hold"
  | "released_hold"
  | "captured_after_completion"
  | "captured_terminal_fee"
  | "refunded_wrong_capture"
  | "orphan_authorisation";

const PREAUTH_HOLD_STATES = new Set(["AUTHORISED", "PROCESSING", "PENDING"]);
const CANCELABLE_HOLD_STATES = new Set(["AUTHORISED", "PROCESSING", "PENDING"]);
const TERMINAL_TRIP_STATUSES = new Set([
  "completed",
  "cancelled",
  "customer_cancelled",
  "driver_cancelled",
  "expired",
  "no_show",
]);

export function isRevolutPreauthHoldState(state: string | undefined | null): boolean {
  return PREAUTH_HOLD_STATES.has(String(state ?? "").toUpperCase());
}

export function isRevolutWrongCaptureBeforeTripComplete(state: string | undefined | null): boolean {
  return String(state ?? "").toUpperCase() === "COMPLETED";
}

/**
 * Provider COMPLETED before trip completion is wrong only for accidental full-fare capture.
 * Intentional no-show / cancel / protection fees (partial or full-auth fee) must not refund.
 */
export function isIntentionalTerminalFeeCapture(args: {
  tripStatus?: string | null;
  financialOutcome?: string | null;
  feeStampPence?: number | null;
  capturedAmountPence?: number | null;
  authorisedAmountPence?: number | null;
  feePenceRequested?: number | null;
}): boolean {
  const captured = Math.max(0, Math.round(Number(args.capturedAmountPence) || 0));
  if (captured <= 0) return false;
  const auth = Math.max(0, Math.round(Number(args.authorisedAmountPence) || 0));
  const feeReq = Math.max(0, Math.round(Number(args.feePenceRequested) || 0));
  const feeStamp = Math.max(0, Math.round(Number(args.feeStampPence) || 0));
  if (feeReq > 0) return true;
  // Partial capture of an open hold is always a terminal fee shape.
  if (auth > 0 && captured < auth) return true;
  if (isChargedFeeOutcome(args.financialOutcome)) return true;
  if (isNonCompletedTerminalTripStatus(args.tripStatus) && feeStamp > 0) return true;
  return false;
}

export function classifyRevolutHoldReconciliation(args: {
  providerOrderState?: string | null;
  tripStatus?: string | null;
  reversalStatus?: string | null;
  paymentInvariantViolation?: boolean;
  hasTrip?: boolean;
  sessionOrphaned?: boolean;
  capturedAmountPence?: number | null;
  authorisedAmountPence?: number | null;
  financialOutcome?: string | null;
  feeStampPence?: number | null;
}): RevolutHoldReconciliationStatus {
  if (args.paymentInvariantViolation) return "refunded_wrong_capture";
  const state = String(args.providerOrderState ?? "").toUpperCase();
  const tripStatus = String(args.tripStatus ?? "").toLowerCase();
  if (args.sessionOrphaned || (!args.hasTrip && isRevolutPreauthHoldState(state))) {
    return "orphan_authorisation";
  }
  if (state === "CANCELLED" || args.reversalStatus === "cancelled") return "released_hold";
  if (state === "COMPLETED" && tripStatus === "completed") return "captured_after_completion";
  if (state === "COMPLETED" && tripStatus !== "completed") {
    if (
      isIntentionalTerminalFeeCapture({
        tripStatus: args.tripStatus,
        financialOutcome: args.financialOutcome,
        feeStampPence: args.feeStampPence,
        capturedAmountPence: args.capturedAmountPence,
        authorisedAmountPence: args.authorisedAmountPence,
      })
    ) {
      return "captured_terminal_fee";
    }
    return "refunded_wrong_capture";
  }
  if (isRevolutPreauthHoldState(state)) return "authorised_hold";
  if (state === "REFUNDED") return "refunded_wrong_capture";
  return "orphan_authorisation";
}

export async function releaseRevolutPreauthForTrip(
  supabase: SupabaseClient,
  args: {
    tripId: string;
    providerOrderId: string;
    reason: string;
    stage: string;
    feePence?: number;
    clientActionId?: string | null;
    idempotencyKey?: string;
    holdTerminalReason?: string;
  },
): Promise<{ released: boolean; status: string; fee_captured_pence?: number; error?: string }> {
  const orderId = args.providerOrderId.trim();
  if (!orderId) return { released: false, status: "skipped", error: "missing_order_id" };

  try {
    const merchant = await resolveRevolutMerchantContext(supabase, "live");
    const order = await retrieveRevolutOrder(merchant.environment, merchant.secretKey, orderId);
    const state = String(order.state ?? "").toUpperCase();
    const feePence = Math.max(0, Math.round(args.feePence ?? 0));
    const authorisedPence = Math.max(0, Number(order.amount ?? 0));

    if (isRevolutWrongCaptureBeforeTripComplete(state)) {
      const completedAmt = Math.max(
        0,
        Math.round(Number(order.completed_amount ?? order.amount ?? 0) || 0),
      );
      // Load trip/fee stamps so full-auth fee captures (fee == auth) are not refunded
      // when a later caller passes feePence: 0 (expire / sweep).
      const { data: tripRow } = await supabase
        .from("trips")
        .select(
          "status, financial_outcome, no_show_charge_pence, cancellation_fee_pence, capture_amount_pence",
        )
        .eq("id", args.tripId)
        .maybeSingle();
      const feeStamp = Math.max(
        0,
        Math.round(Number(tripRow?.no_show_charge_pence) || 0),
        Math.round(Number(tripRow?.cancellation_fee_pence) || 0),
        Math.round(Number(tripRow?.capture_amount_pence) || 0),
      );
      const intentionalFeeCapture = isIntentionalTerminalFeeCapture({
        tripStatus: tripRow?.status as string | null,
        financialOutcome: tripRow?.financial_outcome as string | null,
        feeStampPence: feeStamp,
        capturedAmountPence: completedAmt,
        authorisedAmountPence: authorisedPence,
        feePenceRequested: feePence,
      });
      if (intentionalFeeCapture) {
        await updateTripPaymentReleased(supabase, {
          tripId: args.tripId,
          providerOrderId: orderId,
          paymentStatus: "fee_charged",
          feeCapturedPence: completedAmt,
          clientActionId: args.clientActionId ?? null,
          releaseReason: args.reason,
          holdTerminalReason: args.holdTerminalReason ?? args.reason,
          idempotencyKey: args.idempotencyKey,
          providerOrderPayload: order as Record<string, unknown>,
          retrieveSucceeded: true,
        });
        await auditRevolutHoldAction(supabase, {
          action: "revolut_fee_capture_already_completed",
          providerOrderId: orderId,
          tripId: args.tripId,
          stage: args.stage,
          reason: args.reason,
          providerState: state,
        });
        return {
          released: true,
          status: "fee_charged",
          fee_captured_pence: completedAmt,
        };
      }
      await handleRevolutPaymentInvariantViolation(supabase, {
        providerOrderId: orderId,
        tripId: args.tripId,
        stage: args.stage,
        reason: "capture_before_trip_completion",
        orderAmountPence: authorisedPence,
      });
      return { released: false, status: "wrong_capture_refund_initiated" };
    }

    if (feePence > 0 && CANCELABLE_HOLD_STATES.has(state)) {
      const captureAmount = Math.min(feePence, authorisedPence);
      if (captureAmount > 0) {
        await captureRevolutOrder(
          merchant.environment,
          merchant.secretKey,
          orderId,
          captureAmount,
        );
      }
      const refreshed = await retrieveRevolutOrder(merchant.environment, merchant.secretKey, orderId);
      const afterState = String(refreshed.state ?? "").toUpperCase();
      if (CANCELABLE_HOLD_STATES.has(afterState)) {
        await cancelRevolutOrder(merchant.environment, merchant.secretKey, orderId);
      }
      const paymentStatus = feePence > 0 ? "fee_charged" : "released";
      await updateTripPaymentReleased(supabase, {
        tripId: args.tripId,
        providerOrderId: orderId,
        paymentStatus,
        feeCapturedPence: captureAmount,
        clientActionId: args.clientActionId ?? null,
        releaseReason: args.reason,
        holdTerminalReason: args.holdTerminalReason ?? args.reason,
        idempotencyKey: args.idempotencyKey,
        providerOrderPayload: refreshed as Record<string, unknown>,
        retrieveSucceeded: true,
      });
      await auditRevolutHoldAction(supabase, {
        action: feePence > 0 ? "revolut_partial_capture_on_cancel" : "revolut_hold_released",
        providerOrderId: orderId,
        tripId: args.tripId,
        stage: args.stage,
        reason: args.reason,
        providerState: afterState,
      });
      return {
        released: afterState === "CANCELLED" || feePence > 0,
        status: paymentStatus,
        fee_captured_pence: captureAmount,
      };
    }

    if (!CANCELABLE_HOLD_STATES.has(state)) {
      await auditRevolutHoldAction(supabase, {
        action: "revolut_hold_release_skipped",
        providerOrderId: orderId,
        tripId: args.tripId,
        stage: args.stage,
        reason: args.reason,
        providerState: state,
      });
      return { released: false, status: state.toLowerCase() || "not_cancelable" };
    }

    await cancelRevolutOrder(merchant.environment, merchant.secretKey, orderId);
    await updateTripPaymentReleased(supabase, {
      tripId: args.tripId,
      providerOrderId: orderId,
      paymentStatus: "released",
      clientActionId: args.clientActionId ?? null,
      releaseReason: args.reason,
      holdTerminalReason: args.holdTerminalReason ?? args.reason,
      idempotencyKey: args.idempotencyKey,
    });
    await auditRevolutHoldAction(supabase, {
      action: "revolut_hold_released",
      providerOrderId: orderId,
      tripId: args.tripId,
      stage: args.stage,
      reason: args.reason,
      providerState: "CANCELLED",
    });
    return { released: true, status: "released" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await auditRevolutHoldAction(supabase, {
      action: "revolut_hold_release_failed",
      providerOrderId: orderId,
      tripId: args.tripId,
      stage: args.stage,
      reason: args.reason,
      error: message,
    });
    return { released: false, status: "failed", error: message };
  }
}

export async function handleRevolutPaymentInvariantViolation(
  supabase: SupabaseClient,
  args: {
    providerOrderId: string;
    tripId?: string | null;
    clientActionId?: string | null;
    stage: string;
    reason: string;
    orderAmountPence?: number;
  },
): Promise<{ refunded: boolean; error?: string }> {
  const orderId = args.providerOrderId.trim();
  try {
    const merchant = await resolveRevolutMerchantContext(supabase, "live");
    const order = await retrieveRevolutOrder(merchant.environment, merchant.secretKey, orderId);
    const state = String(order.state ?? "").toUpperCase();
    const amountPence = Math.max(0, Number(order.amount ?? args.orderAmountPence ?? 0));

    if (state === "COMPLETED" || state === "AUTHORISED") {
      try {
        await refundRevolutOrder(
          merchant.environment,
          merchant.secretKey,
          orderId,
          amountPence > 0 ? amountPence : undefined,
          `payment_invariant_violation:${args.reason}`,
        );
      } catch (refundErr) {
        console.error("[revolutPreauthRelease] refund failed", refundErr);
      }
    }

    if (args.tripId) {
      await supabase.from("trips").update({
        payment_status: "refunded",
        updated_at: new Date().toISOString(),
      }).eq("id", args.tripId);
      await supabase.from("payments").update({
        status: "refunded",
        updated_at: new Date().toISOString(),
      }).eq("trip_id", args.tripId).eq("provider_order_id", orderId);
    }

    await supabase.from("orphan_payments").upsert({
      provider_order_id: orderId,
      payment_provider: "revolut",
      amount_pence: amountPence,
      currency: "gbp",
      payment_status: "refunded",
      client_action_id: args.clientActionId ?? null,
      failure_reason: `payment_invariant_violation:${args.reason}`,
      reversal_status: "refunded",
      metadata: {
        provider: "revolut",
        payment_invariant_violation: true,
        hold_reconciliation_status: "refunded_wrong_capture",
        stage: args.stage,
      },
      updated_at: new Date().toISOString(),
    }, { onConflict: "provider_order_id" });

    await auditRevolutHoldAction(supabase, {
      action: "payment_invariant_violation",
      providerOrderId: orderId,
      tripId: args.tripId ?? null,
      stage: args.stage,
      reason: args.reason,
      providerState: state,
      metadata: { hold_reconciliation_status: "refunded_wrong_capture" },
    });

    return { refunded: true };
  } catch (err) {
    return { refunded: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function updateTripPaymentReleased(
  supabase: SupabaseClient,
  args: {
    tripId: string;
    providerOrderId: string;
    paymentStatus: string;
    feeCapturedPence?: number;
    clientActionId?: string | null;
    releaseReason?: string;
    holdTerminalReason?: string;
    idempotencyKey?: string;
    /** Merchant GET/capture response — ACQUIRING fee extract only (never settled_amount invent). */
    providerOrderPayload?: Record<string, unknown> | null;
    retrieveSucceeded?: boolean;
  },
): Promise<void> {
  const patch: Record<string, unknown> = {
    payment_status: args.paymentStatus,
    payment_hold_status: args.paymentStatus === "released" ? "released" : args.paymentStatus,
    updated_at: new Date().toISOString(),
  };
  if (args.feeCapturedPence != null && args.feeCapturedPence > 0) {
    patch.capture_amount_pence = args.feeCapturedPence;
  }
  await supabase.from("trips").update(patch).eq("id", args.tripId);
  await supabase.from("payments").update({
    status: args.paymentStatus,
    captured_amount_pence: args.feeCapturedPence ?? null,
    provider_status: args.paymentStatus === "released" ? "CANCELLED" : undefined,
    updated_at: new Date().toISOString(),
  }).eq("trip_id", args.tripId).eq("provider_order_id", args.providerOrderId);

  // Fee capture must stamp Payment Session as captured (captured_at for 27h) — never release-only.
  if (args.feeCapturedPence != null && args.feeCapturedPence > 0) {
    const { data: sessions } = await supabase
      .from("payment_sessions")
      .select("id, authorised_amount_pence")
      .eq("trip_id", args.tripId)
      .eq("provider_order_id", args.providerOrderId)
      .eq("purpose", "RIDE_BOOKING")
      .limit(1);
    const session = Array.isArray(sessions) && sessions.length === 1 ? sessions[0] : null;
    if (session?.id) {
      const nowIso = new Date().toISOString();
      const authPence = Math.max(0, Math.round(Number(session.authorised_amount_pence) || 0));
      const feePatch = buildFeeCapturePaymentSessionPatch({
        authPence,
        capturedFeePence: args.feeCapturedPence,
        providerState: "COMPLETED",
        capturedAtIso: nowIso,
      });
      const { error: psErr } = await supabase
        .from("payment_sessions")
        .update({
          provider_state: feePatch.provider_state,
          status: feePatch.status,
          captured_amount_pence: feePatch.captured_amount_pence,
          released_amount_pence: feePatch.released_amount_pence,
          captured_at: feePatch.captured_at,
          released_at: feePatch.released_at,
          financial_operation_state: feePatch.financial_operation_state,
          hold_release_state: feePatch.hold_release_state,
          hold_terminal_reason: feePatch.hold_terminal_reason,
          provider_state_verified_at: nowIso,
          provider_state_verified_by: "revolut_preauth_fee_capture",
          updated_at: nowIso,
        })
        .eq("id", session.id);
      if (psErr) {
        console.error("[revolutPreauthRelease] fee-capture PS patch failed", psErr.message);
      } else {
        // Stamp ACQUIRING fee before any wallet/RFO path that reads PS.
        const payload = args.providerOrderPayload ?? null;
        const providerFeePence = extractProviderFeePence(payload);
        try {
          await markPaymentSessionProviderFee(supabase, {
            sessionId: session.id as string,
            providerOrderId: args.providerOrderId,
            clientActionId: args.clientActionId ?? null,
            providerFeePence,
            retrieveSucceeded: args.retrieveSucceeded ?? payload != null,
          });
        } catch (feeErr) {
          console.error(
            "[revolutPreauthRelease] provider fee persist failed",
            feeErr instanceof Error ? feeErr.message : String(feeErr),
          );
        }
      }
    }
    return;
  }

  if (args.paymentStatus === "released" || args.feeCapturedPence === 0) {
    await markPaymentSessionReleased(supabase, {
      providerOrderId: args.providerOrderId,
      clientActionId: args.clientActionId ?? null,
      tripId: args.tripId,
      reason: args.releaseReason ?? args.paymentStatus,
      holdTerminalReason: args.holdTerminalReason ?? args.releaseReason ?? args.paymentStatus,
      providerReleaseReference: args.providerOrderId,
      idempotencyKey: args.idempotencyKey,
    });
  }
}

async function auditRevolutHoldAction(
  supabase: SupabaseClient,
  args: {
    action: string;
    providerOrderId: string;
    tripId?: string | null;
    stage: string;
    reason: string;
    providerState?: string | null;
    error?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await supabase.from("admin_payment_audit").insert({
    action: args.action,
    trip_id: args.tripId ?? null,
    provider: "revolut",
    provider_payment_id: args.providerOrderId,
    metadata: {
      stage: args.stage,
      reason: args.reason,
      provider_state: args.providerState ?? null,
      error: args.error ?? null,
      capture_mode: "manual",
      ...args.metadata,
    },
  }).then(({ error }) => {
    if (error) console.warn("[revolutPreauthRelease] audit insert failed", error.message);
  });
}

export function tripAllowsRevolutHoldRelease(tripStatus: string | undefined | null): boolean {
  const status = String(tripStatus ?? "").toLowerCase();
  return TERMINAL_TRIP_STATUSES.has(status) || status === "searching" || status === "pending";
}

export function resolveRevolutOrderIdFromTrip(trip: Record<string, unknown>): string | null {
  const providerOrderId = String(trip.provider_order_id ?? "").trim();
  return providerOrderId || null;
}
