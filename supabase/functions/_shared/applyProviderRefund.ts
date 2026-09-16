/**
 * Apply provider refund state to ONECAB SSOT via atomic DB RPC.
 * Never inserts REFUND_DEBIT directly — apply_confirmed_provider_refund_atomic only.
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
  providerRefundId: string;
  providerChargeId?: string | null;
  providerPaymentIntentId?: string | null;
  providerOrderId?: string | null;
  provider?: "revolut" | "provider" | string | null;
  source: "webhook" | "admin_sync" | "admin_refund";
  refundReason?: string | null;
  skipDriverWalletReversal?: boolean;
  /** Single refund event amount (delta, not cumulative). */
  thisRefundAmountPence: number;
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
  already_applied: boolean;
  rpc_status: "applied" | "already_applied";
};

type AtomicRpcResult = {
  status: "applied" | "already_applied";
  trip_id?: string;
  payment_session_id?: string;
  provider_refund_id?: string;
  refund_child_id?: string;
  ledger_debit_id?: string | null;
  cumulative_refunded_pence?: number;
  target_driver_reversal_pence?: number;
  authoritative_debit_sum_pence?: number;
  inserted_debit_pence?: number;
  payment_status?: string;
  refund_status?: string;
  error_code?: string;
};

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

function mapRpcError(message: string): Error {
  const code = String(message ?? "").split(":")[0]?.trim() ?? message;
  if (code === "PAYMENT_SESSION_MISSING" || code === "CAPTURE_AMBIGUOUS") {
    return new Error(code);
  }
  if (code === "HISTORICAL_REFUND_DEBIT_REQUIRES_MANUAL_RECONCILIATION") {
    return new Error(code);
  }
  return new Error(message);
}

export async function applyProviderRefundToOnecab(
  supabase: SupabaseClient,
  args: ApplyProviderRefundArgs,
): Promise<ApplyProviderRefundResult> {
  const tripId = await findTripId(supabase, args);
  if (!tripId) throw new Error("Trip not found for refund");

  const providerRefundId = String(args.providerRefundId ?? "").trim();
  if (!providerRefundId) {
    throw new Error("provider_refund_id_required");
  }

  const eventRefundPence = Math.max(0, Math.round(args.thisRefundAmountPence));
  if (eventRefundPence <= 0) {
    throw new Error("thisRefundAmountPence must be > 0");
  }

  const cumulativeRefundedPence = Math.max(0, Math.round(args.amountRefundedPence));
  if (cumulativeRefundedPence <= 0) {
    throw new Error("amountRefundedPence must be > 0");
  }

  const { data: trip, error: tripErr } = await supabase
    .from("trips")
    .select(`
      id, driver_id, payment_status, financial_model,
      final_fare_pence, final_customer_fare_pence, capture_amount_pence,
      commission_pence, driver_net_pence, refund_amount_pence
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

  const paymentProvider = String(args.provider ?? "revolut").trim().toLowerCase() || "revolut";

  const { data: rpcData, error: rpcErr } = await supabase.rpc(
    "apply_confirmed_provider_refund_atomic",
    {
      p_trip_id: tripId,
      p_payment_provider: paymentProvider,
      p_provider_refund_id: providerRefundId,
      p_event_refund_amount_pence: eventRefundPence,
      p_cumulative_refunded_pence: cumulativeRefundedPence,
      p_provider_order_id: args.providerOrderId ?? null,
      p_provider_payment_id: args.providerPaymentIntentId ?? args.providerOrderId ?? null,
      p_refund_reason: args.refundReason ?? null,
      p_source: args.source,
      p_skip_driver_wallet_reversal: args.skipDriverWalletReversal === true,
    },
  );

  if (rpcErr) {
    throw mapRpcError(rpcErr.message);
  }

  const rpc = (rpcData ?? {}) as AtomicRpcResult;
  const rpcStatus = rpc.status === "already_applied" ? "already_applied" : "applied";

  const capturedPence = Math.max(
    0,
    trip.capture_amount_pence
      ?? trip.final_customer_fare_pence
      ?? trip.final_fare_pence
      ?? 0,
  );
  const customerPaidPence = Math.max(
    0,
    trip.final_customer_fare_pence ?? trip.final_fare_pence ?? capturedPence,
  );
  const commissionPence = Math.max(0, trip.commission_pence ?? 0);
  const driverNetPence = Math.max(0, trip.driver_net_pence ?? 0);

  const paymentStatus = rpc.payment_status
    ?? resolveTripPaymentStatusFromRefund(capturedPence, cumulativeRefundedPence)
    ?? "refunded";
  const refundStatus = rpc.refund_status
    ?? resolveRefundStatus(capturedPence, cumulativeRefundedPence);
  const adjusted = applyRefundToTripAmounts({
    capturedPence,
    refundPence: cumulativeRefundedPence,
    commissionPence,
    driverNetPence,
  });

  try {
    await supabase.rpc("log_audit_event", {
      p_event_type: "provider_refund_applied",
      p_trip_id: tripId,
      p_driver_id: trip.driver_id,
      p_details: {
        source: args.source,
        refund_amount_pence: cumulativeRefundedPence,
        provider_refund_id: providerRefundId,
        payment_status: paymentStatus,
        driver_reversal_pence: rpc.target_driver_reversal_pence ?? adjusted.driver_reversal_pence,
        rpc_status: rpcStatus,
      },
    });
  } catch {
    /* optional audit */
  }

  return {
    trip_id: tripId,
    payment_status: paymentStatus,
    refund_status: refundStatus,
    refund_amount_pence: cumulativeRefundedPence,
    net_paid_pence: Math.max(0, customerPaidPence - cumulativeRefundedPence),
    driver_reversal_pence: rpc.target_driver_reversal_pence ?? adjusted.driver_reversal_pence,
    commission_reversal_pence: adjusted.commission_reversal_pence,
    ledger_reversal_inserted: (rpc.inserted_debit_pence ?? 0) > 0,
    already_applied: rpcStatus === "already_applied",
    rpc_status: rpcStatus,
  };
}
