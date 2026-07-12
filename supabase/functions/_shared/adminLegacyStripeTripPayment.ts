/**
 * Legacy Stripe trip payment admin ops — historical trips only.
 * P0: all mutation entry points hard-reject when Stripe runtime is disabled.
 */

import Stripe from "https://esm.sh/stripe@14.21.0";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { tripStripePaymentIntentId, type TripProviderRow } from "./tripPaymentProviderSSOT.ts";
import { assertStripeMutationAllowedOrThrow } from "./stripeRuntimeDisabled.ts";

function assertLegacyStripeMutation(operation: string): void {
  assertStripeMutationAllowedOrThrow(`adminLegacyStripe:${operation}`);
}

export async function adminLegacyStripeCapture(args: {
  supabase: SupabaseClient;
  userId: string;
  trip: TripProviderRow & {
    id: string;
    capture_amount_pence?: number | null;
    authorised_amount_pence?: number | null;
    payment_status?: string | null;
  };
  amountPence?: number;
  reason: string;
  stripeKey: string;
}) {
  assertLegacyStripeMutation("capture");
  const paymentIntentId = tripStripePaymentIntentId(args.trip);
  if (!paymentIntentId) {
    throw new Error("Trip has no legacy Stripe PaymentIntent");
  }

  const stripe = new Stripe(args.stripeKey, { apiVersion: "2023-10-16" });
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId);

  if (pi.status !== "requires_capture") {
    throw new Error(`Cannot capture — PaymentIntent status is "${pi.status}"`);
  }

  const authorizedTotal = pi.amount ?? 0;
  const capturable = pi.amount_capturable ?? authorizedTotal;
  const captureAmount = args.amountPence ?? capturable;

  if (captureAmount <= 0) throw new Error("amount_pence must be > 0");
  if (captureAmount > capturable) {
    throw new Error(`amount_pence (${captureAmount}) exceeds capturable (${capturable})`);
  }

  const before = args.trip.capture_amount_pence ?? 0;
  const captured = await stripe.paymentIntents.capture(
    paymentIntentId,
    { amount_to_capture: captureAmount },
    { idempotencyKey: `admin_capture_${args.trip.id}_${captureAmount}` },
  );

  const charge = captured.latest_charge && typeof captured.latest_charge === "object"
    ? captured.latest_charge as Stripe.Charge
    : null;
  const newCaptured = charge?.amount_captured ?? captureAmount;

  let stripeFee = 0;
  if (charge?.id) {
    try {
      const fullCharge = await stripe.charges.retrieve(charge.id, { expand: ["balance_transaction"] });
      const bt = fullCharge.balance_transaction;
      if (bt && typeof bt === "object" && "fee" in bt) {
        stripeFee = (bt as Stripe.BalanceTransaction).fee ?? 0;
      }
    } catch (feeErr) {
      console.warn("[admin-legacy-stripe-capture] fee fetch failed:", (feeErr as Error).message);
    }
  }

  const { data: tripFin } = await args.supabase
    .from("trips")
    .select("commission_pence")
    .eq("id", args.trip.id)
    .single();
  const commission = tripFin?.commission_pence ?? 0;
  const onecabNet = Math.max(0, commission - stripeFee);

  await args.supabase.from("trips").update({
    payment_status: "captured",
    capture_amount_pence: newCaptured,
    stripe_charge_id: charge?.id ?? null,
    stripe_processing_fee_pence: stripeFee,
    onecab_net_pence: onecabNet,
    updated_at: new Date().toISOString(),
  }).eq("id", args.trip.id);

  await args.supabase.from("admin_payment_audit").insert({
    trip_id: args.trip.id,
    admin_user_id: args.userId,
    action: "capture",
    reason: args.reason,
    amount_pence_before: before,
    amount_pence_after: newCaptured,
    delta_pence: newCaptured - before,
    stripe_payment_intent_id: paymentIntentId,
    provider: "stripe",
    metadata: { authorized_total: authorizedTotal, requested_amount: args.amountPence ?? null, legacy: true },
  });

  return {
    success: true,
    provider: "stripe",
    stripe_payment_intent_id: paymentIntentId,
    stripe_charge_id: charge?.id ?? null,
    captured_pence: newCaptured,
    message: `Captured ${(newCaptured / 100).toFixed(2)} successfully (legacy Stripe)`,
  };
}

export async function adminLegacyStripeRefund(args: {
  supabase: SupabaseClient;
  userId: string;
  trip: TripProviderRow & {
    id: string;
    stripe_charge_id?: string | null;
    refund_amount_pence?: number | null;
  };
  amountPence?: number;
  reason: string;
  stripeKey: string;
}) {
  assertLegacyStripeMutation("refund");
  const paymentIntentId = tripStripePaymentIntentId(args.trip);
  if (!paymentIntentId) throw new Error("Trip has no legacy Stripe PaymentIntent");

  const stripe = new Stripe(args.stripeKey, { apiVersion: "2023-10-16" });
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ["latest_charge"] });

  const charge = pi.latest_charge && typeof pi.latest_charge === "object"
    ? pi.latest_charge as Stripe.Charge
    : null;
  if (!charge) throw new Error("No charge found on PaymentIntent — capture first");

  const captured = charge.amount_captured ?? 0;
  const alreadyRefunded = charge.amount_refunded ?? 0;
  const refundable = Math.max(0, captured - alreadyRefunded);
  if (refundable <= 0) throw new Error("Nothing left to refund");

  const refundAmount = args.amountPence ?? refundable;
  if (refundAmount <= 0) throw new Error("amount_pence must be > 0");
  if (refundAmount > refundable) {
    throw new Error(`amount_pence (${refundAmount}) exceeds refundable (${refundable})`);
  }

  const refund = await stripe.refunds.create(
    {
      charge: charge.id,
      amount: refundAmount,
      reason: "requested_by_customer",
      metadata: { trip_id: args.trip.id, admin_reason: args.reason },
    },
    { idempotencyKey: `admin_refund_${args.trip.id}_${refundAmount}` },
  );

  const newRefunded = alreadyRefunded + refundAmount;
  await args.supabase.from("trips").update({
    payment_status: newRefunded >= captured ? "refunded" : "partially_refunded",
    refund_amount_pence: newRefunded,
    refund_reason: args.reason,
    refunded_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", args.trip.id);

  await args.supabase.from("admin_payment_audit").insert({
    trip_id: args.trip.id,
    admin_user_id: args.userId,
    action: "refund",
    reason: args.reason,
    amount_pence_before: alreadyRefunded,
    amount_pence_after: newRefunded,
    delta_pence: refundAmount,
    stripe_payment_intent_id: paymentIntentId,
    stripe_refund_id: refund.id,
    provider: "stripe",
    metadata: { captured_total: captured, refundable_before: refundable, legacy: true },
  });

  return {
    success: true,
    provider: "stripe",
    stripe_refund_id: refund.id,
    stripe_payment_intent_id: paymentIntentId,
    refunded_pence: refundAmount,
    total_refunded_pence: newRefunded,
    message: `Refunded ${(refundAmount / 100).toFixed(2)} successfully (legacy Stripe)`,
  };
}

export async function adminLegacyStripeCancel(args: {
  supabase: SupabaseClient;
  userId: string;
  trip: TripProviderRow & {
    id: string;
    authorised_amount_pence?: number | null;
    payment_status?: string | null;
  };
  reason: string;
  stripeKey: string;
}) {
  assertLegacyStripeMutation("cancel");
  const paymentIntentId = tripStripePaymentIntentId(args.trip);
  if (!paymentIntentId) throw new Error("Trip has no legacy Stripe PaymentIntent");

  const stripe = new Stripe(args.stripeKey, { apiVersion: "2023-10-16" });
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId);

  const cancellable = ["requires_capture", "requires_payment_method", "requires_confirmation", "requires_action", "processing"];
  if (!cancellable.includes(pi.status)) {
    throw new Error(`Cannot cancel — PaymentIntent status is "${pi.status}"`);
  }

  const before = pi.amount ?? args.trip.authorised_amount_pence ?? 0;
  const cancelled = await stripe.paymentIntents.cancel(
    paymentIntentId,
    { cancellation_reason: "requested_by_customer" },
  );

  await args.supabase.from("trips").update({
    payment_status: "cancelled",
    capture_amount_pence: 0,
    updated_at: new Date().toISOString(),
  }).eq("id", args.trip.id);

  await args.supabase.from("admin_payment_audit").insert({
    trip_id: args.trip.id,
    admin_user_id: args.userId,
    action: "cancel",
    reason: args.reason,
    amount_pence_before: before,
    amount_pence_after: 0,
    delta_pence: -before,
    stripe_payment_intent_id: paymentIntentId,
    provider: "stripe",
    metadata: { previous_status: pi.status, cancelled_status: cancelled.status, legacy: true },
  });

  return {
    success: true,
    provider: "stripe",
    stripe_payment_intent_id: paymentIntentId,
    released_pence: before,
    message: `Hold released — ${(before / 100).toFixed(2)} returned to customer (legacy Stripe).`,
  };
}

export async function adminLegacyStripeSyncFromProvider(args: {
  supabase: SupabaseClient;
  userId: string;
  trip: TripProviderRow & { id: string; commission_pence?: number | null };
  stripeKey: string;
}) {
  assertLegacyStripeMutation("sync");
  const paymentIntentId = tripStripePaymentIntentId(args.trip);
  if (!paymentIntentId) throw new Error("Trip has no legacy Stripe PaymentIntent");

  const stripe = new Stripe(args.stripeKey, { apiVersion: "2023-10-16" });
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
    expand: ["latest_charge", "latest_charge.balance_transaction"],
  });

  const charge = pi.latest_charge && typeof pi.latest_charge === "object"
    ? pi.latest_charge as Stripe.Charge
    : null;

  let capturedPence = 0;
  let refundedPence = 0;
  let stripeFee = 0;
  let chargeId: string | null = null;

  if (charge) {
    chargeId = charge.id;
    capturedPence = charge.amount_captured ?? 0;
    refundedPence = charge.amount_refunded ?? 0;
    const bt = charge.balance_transaction;
    if (bt && typeof bt === "object" && "fee" in bt) {
      stripeFee = (bt as Stripe.BalanceTransaction).fee ?? 0;
    }
  }

  const paymentStatus = pi.status === "succeeded"
    ? (refundedPence >= capturedPence && capturedPence > 0 ? "refunded" : "captured")
    : pi.status === "canceled"
      ? "cancelled"
      : pi.status === "requires_capture"
        ? "authorized"
        : undefined;

  const commission = args.trip.commission_pence ?? 0;
  const tripPatch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (paymentStatus) tripPatch.payment_status = paymentStatus;
  if (capturedPence > 0) tripPatch.capture_amount_pence = capturedPence;
  if (refundedPence > 0) tripPatch.refund_amount_pence = refundedPence;
  if (chargeId) tripPatch.stripe_charge_id = chargeId;
  if (stripeFee > 0) {
    tripPatch.stripe_processing_fee_pence = stripeFee;
    tripPatch.onecab_net_pence = Math.max(0, commission - stripeFee);
  }

  await args.supabase.from("trips").update(tripPatch).eq("id", args.trip.id);

  await args.supabase.from("admin_payment_audit").insert({
    trip_id: args.trip.id,
    admin_user_id: args.userId,
    action: "sync_stripe",
    reason: "Read-only sync from Stripe (legacy trip audit backfill)",
    amount_pence_before: null,
    amount_pence_after: capturedPence,
    delta_pence: null,
    stripe_payment_intent_id: paymentIntentId,
    provider: "stripe",
    metadata: {
      stripe_status: pi.status,
      captured_pence: capturedPence,
      refunded_pence: refundedPence,
      stripe_fee_pence: stripeFee,
      read_only_sync: true,
    },
  });

  return {
    success: true,
    provider: "stripe",
    stripe_status: pi.status,
    captured_pence: capturedPence,
    refunded_pence: refundedPence,
    stripe_fee_pence: stripeFee,
    message: "Synced from Stripe (legacy trip — read-only backfill)",
  };
}
