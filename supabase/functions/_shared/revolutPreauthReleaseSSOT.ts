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
import { markPaymentSessionReleased } from "./paymentSessionSSOT.ts";

export type RevolutHoldReconciliationStatus =
  | "authorised_hold"
  | "released_hold"
  | "captured_after_completion"
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

export function classifyRevolutHoldReconciliation(args: {
  providerOrderState?: string | null;
  tripStatus?: string | null;
  reversalStatus?: string | null;
  paymentInvariantViolation?: boolean;
  hasTrip?: boolean;
  sessionOrphaned?: boolean;
}): RevolutHoldReconciliationStatus {
  if (args.paymentInvariantViolation) return "refunded_wrong_capture";
  const state = String(args.providerOrderState ?? "").toUpperCase();
  const tripStatus = String(args.tripStatus ?? "").toLowerCase();
  if (args.sessionOrphaned || (!args.hasTrip && isRevolutPreauthHoldState(state))) {
    return "orphan_authorisation";
  }
  if (state === "CANCELLED" || args.reversalStatus === "cancelled") return "released_hold";
  if (state === "COMPLETED" && tripStatus === "completed") return "captured_after_completion";
  if (state === "COMPLETED" && tripStatus !== "completed") return "refunded_wrong_capture";
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
      }).eq("trip_id", args.tripId).or(`provider_order_id.eq.${orderId},stripe_payment_intent_id.eq.${orderId}`);
    }

    await supabase.from("orphan_payments").upsert({
      stripe_payment_intent_id: orderId,
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
    }, { onConflict: "stripe_payment_intent_id" });

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
  }).eq("trip_id", args.tripId).or(`provider_order_id.eq.${args.providerOrderId},stripe_payment_intent_id.eq.${args.providerOrderId}`);

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
  const provider = String(trip.payment_provider ?? "").toLowerCase();
  const providerOrderId = String(trip.provider_order_id ?? "").trim();
  if (providerOrderId) return providerOrderId;
  if (provider === "revolut") {
    const legacy = String(trip.stripe_payment_intent_id ?? "").trim();
    if (legacy && !legacy.startsWith("pi_")) return legacy;
  }
  return null;
}
