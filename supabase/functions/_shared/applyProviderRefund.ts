/**
 * Apply provider refund state to ONECAB SSOT — trips, payments, trip_finance, driver ledger.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  applyRefundToTripAmounts,
  resolveRefundStatus,
  resolveTripPaymentStatusFromRefund,
} from "./refundSSOT.ts";

export type ApplyProviderRefundArgs = {
  tripId: string;
  amountRefundedPence: number;
  providerRefundId?: string | null;
  providerOrderId?: string | null;
  source: "webhook" | "admin_sync" | "admin_refund";
  refundReason?: string | null;
};

export type ApplyProviderRefundResult = {
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
  args: Pick<ApplyProviderRefundArgs, "tripId" | "providerOrderId">,
): Promise<string | null> {
  if (args.tripId) return args.tripId;

  if (args.providerOrderId) {
    const { data } = await supabase
      .from("trips")
      .select("id")
      .eq("provider_order_id", args.providerOrderId)
      .maybeSingle();
    if (data?.id) return String(data.id);
  }

  return null;
}

async function applyRefundToOnecab(
  supabase: SupabaseClient,
  args: ApplyProviderRefundArgs,
): Promise<ApplyProviderRefundResult> {
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
      payment_provider, provider_order_id
    `)
    .eq("id", tripId)
    .single();
  if (tripErr || !trip) throw new Error(`Trip not found: ${tripId}`);

  const { data: paymentRows } = await supabase
    .from("payments")
    .select("id, captured_amount_pence, amount_pence, status, provider_charge_id")
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
      last_error: args.providerRefundId
        ? `provider_refund:${args.providerRefundId}:${refundedPence}`
        : `${args.source}:${refundedPence}`,
    };

    const { error: payErr } = await supabase
      .from("payments")
      .update(paymentPatch)
      .eq("id", payment.id);
    if (payErr) {
      console.warn("[applyProviderRefund] payments update failed (column may be missing)", payErr.message);
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
    console.warn("[applyProviderRefund] trip_finance update skipped", financeErr.message);
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
          description: args.providerRefundId
            ? `Provider refund reversal (${args.providerRefundId}) — ${args.source}`
            : `Provider refund reversal — ${args.source}`,
        });
        if (!ledgerErr) ledgerReversalInserted = true;
        else console.warn("[applyProviderRefund] REFUND_DEBIT insert failed", ledgerErr.message);
      }
    }
  }

  try {
    await supabase.rpc("log_audit_event", {
      p_event_type: "provider_refund_applied",
      p_trip_id: tripId,
      p_driver_id: driverId,
      p_details: {
        source: args.source,
        refund_amount_pence: refundedPence,
        provider_refund_id: args.providerRefundId ?? null,
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

/** Provider-agnostic refund apply — Revolut is the only active card provider. */
export async function applyProviderRefundToOnecab(
  supabase: SupabaseClient,
  args: {
    tripId: string;
    amountRefundedPence: number;
    provider?: "revolut" | string | null;
    providerRefundId?: string | null;
    providerOrderId?: string | null;
    source: "webhook" | "admin_sync" | "admin_refund";
    refundReason?: string | null;
  },
): Promise<ApplyProviderRefundResult> {
  const result = await applyRefundToOnecab(supabase, {
    tripId: args.tripId,
    amountRefundedPence: args.amountRefundedPence,
    providerRefundId: args.providerRefundId ?? null,
    providerOrderId: args.providerOrderId ?? null,
    source: args.source,
    refundReason: args.refundReason ?? null,
  });

  // Keep payment_sessions in sync for Payment Sessions overcapture UI.
  // payment_sessions is the only table with a provider-neutral refund id column.
  const now = new Date().toISOString();
  const sessionPatch: Record<string, unknown> = {
    refunded_amount_pence: args.amountRefundedPence,
    updated_at: now,
  };
  if (args.providerRefundId) sessionPatch.provider_refund_id = args.providerRefundId;

  const { error: psErr } = await supabase
    .from("payment_sessions")
    .update(sessionPatch)
    .eq("trip_id", args.tripId)
    .not("captured_amount_pence", "is", null);
  if (psErr) {
    console.warn("[applyProviderRefund] payment_sessions update skipped", psErr.message);
  }

  return result;
}
