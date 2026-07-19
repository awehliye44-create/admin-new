/**
 * Apply Stripe refund state to ONECAB SSOT — trips, payments, trip_finance, driver ledger.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  applyRefundToTripAmounts,
  resolveRefundStatus,
  resolveTripPaymentStatusFromRefund,
} from "../../../shared/stripeRefundSSOT.ts";

export type ApplyStripeRefundArgs = {
  tripId: string;
  amountRefundedPence: number;
  stripeRefundId?: string | null;
  stripeChargeId?: string | null;
  stripePaymentIntentId?: string | null;
  source: "webhook" | "admin_sync" | "admin_refund";
  refundReason?: string | null;
};

export type ApplyStripeRefundResult = {
  trip_id: string;
  payment_status: string;
  refund_status: string;
  refund_amount_pence: number;
  net_paid_pence: number;
  driver_reversal_pence: number;
  commission_reversal_pence: number;
  ledger_reversal_inserted: boolean;
};

const REFUND_DEBIT_TYPE = "REFUND_DEBIT";

async function findTripId(
  supabase: SupabaseClient,
  args: Pick<ApplyStripeRefundArgs, "tripId" | "stripePaymentIntentId" | "stripeChargeId">,
): Promise<string | null> {
  if (args.tripId) return args.tripId;

  if (args.stripePaymentIntentId) {
    const { data } = await supabase
      .from("trips")
      .select("id")
      .eq("stripe_payment_intent_id", args.stripePaymentIntentId)
      .maybeSingle();
    if (data?.id) return String(data.id);
  }

  if (args.stripeChargeId) {
    const { data } = await supabase
      .from("trips")
      .select("id")
      .eq("stripe_charge_id", args.stripeChargeId)
      .maybeSingle();
    if (data?.id) return String(data.id);
  }

  return null;
}

export async function applyStripeRefundToOnecab(
  supabase: SupabaseClient,
  args: ApplyStripeRefundArgs,
): Promise<ApplyStripeRefundResult> {
  const tripId = await findTripId(supabase, args);
  if (!tripId) throw new Error("Trip not found for refund");

  const refundedPence = Math.max(0, Math.round(args.amountRefundedPence));
  if (refundedPence <= 0) throw new Error("amountRefundedPence must be > 0");

  const { data: trip, error: tripErr } = await supabase
    .from("trips")
    .select(`
      id, driver_id, payment_status, payment_method,
      final_fare_pence, final_customer_fare_pence, capture_amount_pence,
      commission_pence, driver_net_pence, refund_amount_pence,
      stripe_payment_intent_id, stripe_charge_id
    `)
    .eq("id", tripId)
    .single();
  if (tripErr || !trip) throw new Error(`Trip not found: ${tripId}`);

  const { data: paymentRows } = await supabase
    .from("payments")
    .select("id, captured_amount_pence, amount_pence, status, stripe_payment_intent_id")
    .eq("trip_id", tripId)
    .order("created_at", { ascending: false });

  const primaryPayment = (paymentRows ?? [])[0] ?? null;
  const capturedPence = Math.max(
    0,
    primaryPayment?.captured_amount_pence
      ?? trip.capture_amount_pence
      ?? trip.final_customer_fare_pence
      ?? trip.final_fare_pence
      ?? primaryPayment?.amount_pence
      ?? 0,
  );

  const customerPaidPence = Math.max(
    0,
    trip.final_customer_fare_pence ?? trip.final_fare_pence ?? capturedPence,
  );

  const paymentStatus = resolveTripPaymentStatusFromRefund(capturedPence, refundedPence)
    ?? (trip.payment_status as string | null)
    ?? "refunded";
  const refundStatus = resolveRefundStatus(capturedPence, refundedPence);
  const now = new Date().toISOString();

  const commissionPence = Math.max(0, trip.commission_pence ?? 0);
  const driverNetPence = Math.max(0, trip.driver_net_pence ?? 0);
  const adjusted = applyRefundToTripAmounts({
    capturedPence,
    refundPence: refundedPence,
    commissionPence,
    driverNetPence,
  });

  const netPaidPence = Math.max(0, customerPaidPence - refundedPence);

  const tripUpdate: Record<string, unknown> = {
    payment_status: paymentStatus,
    refund_amount_pence: refundedPence,
    refunded_at: now,
    updated_at: now,
  };
  if (args.refundReason) tripUpdate.refund_reason = args.refundReason;
  if (args.stripeChargeId) tripUpdate.stripe_charge_id = args.stripeChargeId;

  const { error: tripUpdateErr } = await supabase.from("trips").update(tripUpdate).eq("id", tripId);
  if (tripUpdateErr) throw new Error(`trips refund update failed: ${tripUpdateErr.message}`);

  for (const payment of paymentRows ?? []) {
    const payStatus = paymentStatus === "partially_refunded" ? "partially_refunded" : "refunded";
    const paymentPatch: Record<string, unknown> = {
      status: payStatus,
      refunded_amount_pence: refundedPence,
      refund_status: refundStatus,
      refunded_at: now,
      updated_at: now,
      last_error: args.stripeRefundId
        ? `stripe_refund:${args.stripeRefundId}:${refundedPence}`
        : `${args.source}:${refundedPence}`,
    };
    if (args.stripeRefundId) paymentPatch.stripe_refund_id = args.stripeRefundId;

    const { error: payErr } = await supabase
      .from("payments")
      .update(paymentPatch)
      .eq("id", payment.id);
    if (payErr) {
      console.warn("[applyStripeRefund] payments update failed (column may be missing)", payErr.message);
      const { error: fallbackErr } = await supabase
        .from("payments")
        .update({
          status: payStatus,
          updated_at: now,
          last_error: paymentPatch.last_error,
        })
        .eq("id", payment.id);
      if (fallbackErr) throw new Error(`payments refund update failed: ${fallbackErr.message}`);
    }
  }

  const financePatch: Record<string, unknown> = {
    refund_amount_pence: refundedPence,
    refund_status: refundStatus,
    net_card_revenue_after_refund_pence: adjusted.net_captured_pence,
    driver_wallet_reversal_pence: adjusted.driver_reversal_pence,
    commission_reversal_pence: adjusted.commission_reversal_pence,
    financial_status: refundStatus === "refunded" ? "REFUNDED" : "PARTIALLY_REFUNDED",
    updated_at: now,
  };

  const { error: financeErr } = await supabase
    .from("trip_finance")
    .update(financePatch)
    .eq("trip_id", tripId);
  if (financeErr) {
    console.warn("[applyStripeRefund] trip_finance update skipped", financeErr.message);
  }

  let ledgerReversalInserted = false;
  const driverId = trip.driver_id as string | null;
  if (driverId && adjusted.driver_reversal_pence > 0) {
    const { data: existingDebit } = await supabase
      .from("driver_wallet_ledger")
      .select("id")
      .eq("related_trip_id", tripId)
      .eq("type", REFUND_DEBIT_TYPE)
      .maybeSingle();

    if (!existingDebit) {
      const { data: earningRows } = await supabase
        .from("driver_wallet_ledger")
        .select("id, type, amount_pence")
        .eq("driver_id", driverId)
        .eq("related_trip_id", tripId)
        .in("type", ["TRIP_EARNING_NET", "DRIVER_TIP_CREDIT"]);

      const creditedPence = (earningRows ?? []).reduce(
        (sum, row) => sum + Math.max(0, Number(row.amount_pence ?? 0)),
        0,
      );

      const reversalPence = creditedPence > 0
        ? Math.min(creditedPence, adjusted.driver_reversal_pence)
        : adjusted.driver_reversal_pence;

      if (reversalPence > 0) {
        const { error: ledgerErr } = await supabase.from("driver_wallet_ledger").insert({
          driver_id: driverId,
          related_trip_id: tripId,
          type: REFUND_DEBIT_TYPE,
          amount_pence: -reversalPence,
          currency: "GBP",
          description: args.stripeRefundId
            ? `Stripe refund reversal (${args.stripeRefundId}) — ${args.source}`
            : `Stripe refund reversal — ${args.source}`,
        });
        if (!ledgerErr) ledgerReversalInserted = true;
        else console.warn("[applyStripeRefund] REFUND_DEBIT insert failed", ledgerErr.message);
      }
    }
  }

  try {
    await supabase.rpc("log_audit_event", {
      p_event_type: "stripe_refund_applied",
      p_trip_id: tripId,
      p_driver_id: driverId,
      p_details: {
        source: args.source,
        refund_amount_pence: refundedPence,
        stripe_refund_id: args.stripeRefundId ?? null,
        payment_status: paymentStatus,
        driver_reversal_pence: adjusted.driver_reversal_pence,
      },
    });
  } catch {
    /* optional audit */
  }

  return {
    trip_id: tripId,
    payment_status: paymentStatus,
    refund_status: refundStatus,
    refund_amount_pence: refundedPence,
    net_paid_pence: netPaidPence,
    driver_reversal_pence: adjusted.driver_reversal_pence,
    commission_reversal_pence: adjusted.commission_reversal_pence,
    ledger_reversal_inserted: ledgerReversalInserted,
  };
}

/** Provider-agnostic refund apply — Revolut admin refunds + legacy Stripe. */
export async function applyProviderRefundToOnecab(
  supabase: SupabaseClient,
  args: {
    tripId: string;
    amountRefundedPence: number;
    provider?: "revolut" | "stripe" | string | null;
    providerRefundId?: string | null;
    providerOrderId?: string | null;
    source: "webhook" | "admin_sync" | "admin_refund";
    refundReason?: string | null;
  },
): Promise<ApplyStripeRefundResult> {
  const result = await applyStripeRefundToOnecab(supabase, {
    tripId: args.tripId,
    amountRefundedPence: args.amountRefundedPence,
    stripeRefundId: args.providerRefundId ?? null,
    stripePaymentIntentId: args.providerOrderId ?? null,
    source: args.source,
    refundReason: args.refundReason ?? null,
  });

  // Keep payment_sessions in sync for Payment Sessions overcapture UI.
  const now = new Date().toISOString();
  const { error: psErr } = await supabase
    .from("payment_sessions")
    .update({
      refunded_amount_pence: args.amountRefundedPence,
      updated_at: now,
    })
    .eq("trip_id", args.tripId)
    .not("captured_amount_pence", "is", null);
  if (psErr) {
    console.warn("[applyProviderRefund] payment_sessions update skipped", psErr.message);
  }

  return result;
}
