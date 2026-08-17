/**
 * Apply provider refund state to ONECAB SSOT — trips, payments, trip_finance, driver ledger.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  applyRefundToTripAmounts,
  resolveRefundStatus,
  resolveTripPaymentStatusFromRefund,
} from "./providerRefundSSOT.ts";
import { FINANCIAL_MODEL_VIOLATION, SERVICE_AREA_FINANCIAL_MODEL } from "./commissionWalletSSOT.ts";

export type ApplyProviderRefundArgs = {
  tripId: string;
  amountRefundedPence: number;
  providerRefundId?: string | null;
  providerChargeId?: string | null;
  providerPaymentIntentId?: string | null;
  /** Revolut admin refunds pass the merchant order id here. */
  providerOrderId?: string | null;
  provider?: "revolut" | "provider" | string | null;
  source: "webhook" | "admin_sync" | "admin_refund";
  refundReason?: string | null;
  /**
   * When true, skip proportional REFUND_DEBIT on driver_wallet_ledger.
   * Use for overcapture remediations where wallet is corrected separately
   * to canonical driver_net (e.g. MK-260815-029 settlement correction).
   */
  skipDriverWalletReversal?: boolean;
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
  args: Pick<
    ApplyProviderRefundArgs,
    "tripId" | "providerPaymentIntentId" | "providerOrderId" | "providerChargeId"
  >,
): Promise<string | null> {
  if (args.tripId) return args.tripId;

  const paymentIntentId = args.providerPaymentIntentId ?? args.providerOrderId ?? null;
  if (paymentIntentId) {
    const { data } = await supabase
      .from("trips")
      .select("id")
      .eq("provider_payment_id", paymentIntentId)
      .maybeSingle();
    if (data?.id) return String(data.id);
  }

  if (args.providerChargeId) {
    const { data } = await supabase
      .from("trips")
      .select("id")
      .eq("provider_charge_id", args.providerChargeId)
      .maybeSingle();
    if (data?.id) return String(data.id);
  }

  return null;
}

export async function applyProviderRefundToOnecab(
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
      id, driver_id, payment_status, payment_method, financial_model,
      final_fare_pence, final_customer_fare_pence, capture_amount_pence,
      commission_pence, driver_net_pence, refund_amount_pence,
      provider_payment_id, provider_charge_id
    `)
    .eq("id", tripId)
    .single();
  if (tripErr || !trip) throw new Error(`Trip not found: ${tripId}`);

  if (
    String(trip.financial_model ?? "").toUpperCase()
    === SERVICE_AREA_FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET
  ) {
    throw new Error(
      `${FINANCIAL_MODEL_VIOLATION}: platform refund forbidden on DRIVER_COLLECTED_COMMISSION_WALLET`,
    );
  }

  const { data: paymentRows } = await supabase
    .from("payments")
    .select("id, captured_amount_pence, amount_pence, status, provider_payment_id")
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
  if (args.providerChargeId) tripUpdate.provider_charge_id = args.providerChargeId;

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
    if (args.providerRefundId) paymentPatch.provider_refund_id = args.providerRefundId;

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
  if (driverId && adjusted.driver_reversal_pence > 0 && !args.skipDriverWalletReversal) {
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
            ? `provider refund reversal (${args.providerRefundId}) — ${args.source}`
            : `provider refund reversal — ${args.source}`,
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

  // Keep payment_sessions in sync for Payment Sessions overcapture UI.
  const { error: psErr } = await supabase
    .from("payment_sessions")
    .update({
      refunded_amount_pence: refundedPence,
      updated_at: now,
    })
    .eq("trip_id", tripId)
    .not("captured_amount_pence", "is", null);
  if (psErr) {
    console.warn("[applyProviderRefund] payment_sessions update skipped", psErr.message);
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
