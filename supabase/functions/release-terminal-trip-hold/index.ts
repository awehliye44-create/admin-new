/**
 * release-terminal-trip-hold
 *
 * Service-role / cron entry for disposing Revolut authorisations on terminal
 * non-completed trips. Invoked by cancel-trip, SQL expiry, admin cancel, and
 * the stale-holds sweep.
 *
 * Dry-run supported: { dry_run: true } classifies without provider mutation.
 *
 * When dispose proves a fee capture, posts Driver Wallet TEN via RFO (idempotent).
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { assertCronOrServiceRoleAuth } from "../_shared/cronEdgeAuth.ts";
import {
  classifyTerminalHoldDisposition,
  disposeTerminalTripPayment,
  type TerminalDispositionReason,
} from "../_shared/terminalTripPaymentDisposition.ts";
import { resolveTripPaymentProvider, tripProviderOrderId } from "../_shared/tripPaymentProviderSSOT.ts";
import {
  disposeOutcomeIndicatesFeeCapture,
  isChargedFeeOutcome,
  postChargedFeeTenViaRfo,
  resolveAssignedDriverId,
} from "../_shared/chargedTerminalFeeWalletSSOT.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-onecab-cron-secret",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const auth = await assertCronOrServiceRoleAuth(req, body);
  if (!auth.ok) return auth.response;

  const tripId = typeof body.trip_id === "string" ? body.trip_id : null;
  const dryRun = body.dry_run === true;
  const reason = (typeof body.reason === "string" ? body.reason : "sweep_fallback") as TerminalDispositionReason;
  const feePence = typeof body.fee_pence === "number" ? body.fee_pence : undefined;

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  if (!tripId) {
    return new Response(JSON.stringify({ success: false, error: "trip_id required" }), {
      status: 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  if (dryRun) {
    const { data: trip } = await supabase
      .from("trips")
      .select("id, status, started_at, payment_provider, provider_order_id, cancellation_fee_pence, no_show_charge_pence")
      .eq("id", tripId)
      .maybeSingle();
    if (!trip) {
      return new Response(JSON.stringify({ success: false, error: "trip_not_found", dry_run: true }), {
        status: 404,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    const classified = classifyTerminalHoldDisposition({
      tripStatus: trip.status,
      startedAt: trip.started_at,
      feePence: feePence ?? trip.cancellation_fee_pence ?? trip.no_show_charge_pence ?? 0,
      hasProviderOrder: !!tripProviderOrderId(trip),
      provider: resolveTripPaymentProvider(trip),
    });
    return new Response(JSON.stringify({ success: true, dry_run: true, trip_id: tripId, classified }), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const result = await disposeTerminalTripPayment(supabase, {
    tripId,
    reason,
    feePence,
    // Explicit fee_pence from caller is authoritative — without override it was ignored.
    forceFeePenceOverride: typeof feePence === "number",
  });

  let walletSettlement: Awaited<ReturnType<typeof postChargedFeeTenViaRfo>> | null = null;
  if (disposeOutcomeIndicatesFeeCapture(result)) {
    const { data: trip } = await supabase
      .from("trips")
      .select(
        "id, driver_id, confirmed_driver_id, financial_outcome, payment_method, cancellation_fee_pence, no_show_charge_pence, late_cancel_fee_pence",
      )
      .eq("id", tripId)
      .maybeSingle();
    const stamped = String(trip?.financial_outcome ?? "").trim().toUpperCase();
    const outcome = isChargedFeeOutcome(stamped) ? stamped : "CANCELLED_WITH_FEE";
    // Optional body.driver_id — cancel trigger may null trip.driver_id; caller may pass assignee for wallet only.
    const bodyDriverId = typeof body.driver_id === "string" ? body.driver_id.trim() : null;
    const driverId = resolveAssignedDriverId({
      driver_id: trip?.driver_id,
      confirmed_driver_id: trip?.confirmed_driver_id,
      accepted_offer_driver_id: bodyDriverId,
    });
    walletSettlement = await postChargedFeeTenViaRfo({
      supabaseUrl,
      serviceRoleKey,
      tripId,
      driverId,
      outcome,
      feePence: Math.round(Number(result.captured_fee_pence) || 0),
      paymentMethod: trip?.payment_method ?? null,
      disposition: result,
    });
    if (walletSettlement.status !== "SUCCEEDED") {
      console.error("[release-terminal-trip-hold] WALLET_SETTLEMENT_FAILED_AFTER_FEE_CAPTURE", {
        trip_id: tripId,
        walletSettlement,
        captured_fee_pence: result.captured_fee_pence,
      });
    }
  }

  const ok = [
    "RELEASED_AND_RECONCILED",
    "ALREADY_RELEASED_RECONCILED",
    "FEE_CAPTURED_AND_REMAINDER_RELEASED",
    "SKIPPED_REMATCH_OR_ACTIVE",
    "SKIPPED_COMPLETED",
    "SKIPPED_NO_ORDER",
    "SKIPPED_NOT_REVOLUT",
  ].includes(result.outcome);

  const feeCapturedWalletOk =
    !disposeOutcomeIndicatesFeeCapture(result) ||
    walletSettlement?.status === "SUCCEEDED";

  return new Response(
    JSON.stringify({
      success: ok && feeCapturedWalletOk,
      ...result,
      wallet_settlement_status: walletSettlement?.status ?? "NOT_REQUIRED",
      wallet_settlement_error: walletSettlement?.error ?? null,
    }),
    {
      status:
        (ok || result.outcome.startsWith("SKIPPED") || result.outcome === "HOLD_PROTECTED") &&
          feeCapturedWalletOk
          ? 200
          : 502,
      headers: { ...cors, "Content-Type": "application/json" },
    },
  );
});
