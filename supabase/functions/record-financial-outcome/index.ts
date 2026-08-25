/**
 * record-financial-outcome
 *
 * Records financially countable terminal fee outcomes:
 *   NO_SHOW | LATE_PASSENGER_CANCELLATION | AIRPORT_PROTECTION_CANCELLATION | CANCELLED_WITH_FEE
 *   (and other charged terminal cancellation/protection outcomes)
 *
 * Policy: TEN = captured fee − known PS provider_processing_fee_pence (fee_status ACTUAL);
 * commission = 0. Provider fee unknown → fail closed (no invent). economic_earned_at from PS.captured_at (27h).
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { resolveCurrencyFromTrip } from "../_shared/regionCurrency.ts";
import { assertServiceRole } from "../_shared/internalAuth.ts";
import { tripBlocksDriverWalletLedgerPosting } from "../_shared/commissionWalletDeduction.ts";
import {
  buildChargedFeeTenLedgerInsert,
  isChargedFeeOutcome,
  readKnownProviderFeePence,
  resolveChargedTerminalFeeEntitlement,
} from "../_shared/chargedTerminalFeeWalletSSOT.ts";
import { readTripEarningNetLedgerState } from "../_shared/tripEarningNetLedgerReadback.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const gate = assertServiceRole(req);
  if (gate) return gate;

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const body = await req.json();
    const trip_id = body?.trip_id;
    const driver_id = body?.driver_id;
    const outcome = body?.outcome;
    const fee_pence = body?.fee_pence;
    const payment_method = body?.payment_method;
    const economic_earned_at_hint = typeof body?.economic_earned_at === "string"
      ? body.economic_earned_at
      : null;

    if (!trip_id || !driver_id || !outcome || typeof fee_pence !== "number") {
      return new Response(
        JSON.stringify({
          error: "Missing required fields: trip_id, driver_id, outcome, fee_pence",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (!isChargedFeeOutcome(outcome)) {
      return new Response(
        JSON.stringify({
          error:
            "Invalid outcome. Must be a charged terminal fee outcome (NO_SHOW, LATE_PASSENGER_CANCELLATION, AIRPORT_PROTECTION_CANCELLATION, CANCELLED_WITH_FEE, …)",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    let currency_code: string;
    try {
      // regionCurrency uses esm.sh client types; runtime clients are interchangeable.
      // deno-lint-ignore no-explicit-any
      const regionCurrency = await resolveCurrencyFromTrip(supabase as any, trip_id);
      currency_code = regionCurrency.currency_code;
    } catch (e) {
      console.error(`[record-financial-outcome] Currency resolution failed:`, e);
      return new Response(
        JSON.stringify({ error: (e as Error).message }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { data: trip, error: tripError } = await supabase
      .from("trips")
      .select("id, status, driver_id, service_area_id, financial_outcome")
      .eq("id", trip_id)
      .single();

    if (tripError || !trip) {
      return new Response(
        JSON.stringify({ error: "Trip not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Prefer canonical Payment Session captured amount + known provider fee.
    // Body fee_pence is fallback when PS captured stamp is not yet present.
    const { data: psRows } = await supabase
      .from("payment_sessions")
      .select(
        "id, captured_at, captured_amount_pence, provider_processing_fee_pence, fee_status, status, provider_state",
      )
      .eq("trip_id", trip_id)
      .eq("purpose", "RIDE_BOOKING")
      .order("created_at", { ascending: true })
      .limit(2);
    const ps = Array.isArray(psRows) && psRows.length === 1 ? psRows[0] : null;
    const psCaptured = Math.max(0, Math.round(Number(ps?.captured_amount_pence) || 0));
    const feeForEntitlement = psCaptured > 0 ? psCaptured : fee_pence;
    const providerFeePence = readKnownProviderFeePence(ps?.provider_processing_fee_pence);
    const feeStatus = ps?.fee_status ?? null;

    const entitlement = resolveChargedTerminalFeeEntitlement({
      outcome,
      feePence: feeForEntitlement,
      providerFeePence,
      feeStatus,
    });
    if (!entitlement.ok) {
      const errorCode = entitlement.reason === "provider_fee_unknown"
        ? "PROVIDER_FEE_UNKNOWN"
        : entitlement.reason === "driver_ten_non_positive"
        ? "DRIVER_TEN_NON_POSITIVE"
        : "ENTITLEMENT_REJECTED";
      console.error(`[record-financial-outcome] ${errorCode} for ${trip_id}:`, entitlement.reason, {
        feeForEntitlement,
        provider_processing_fee_pence: ps?.provider_processing_fee_pence ?? null,
        fee_status: feeStatus,
      });
      return new Response(
        JSON.stringify({
          success: false,
          error: entitlement.reason,
          error_code: errorCode,
          trip_id,
          captured_fee_pence: feeForEntitlement,
          provider_fee_pence: providerFeePence,
        }),
        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const economicEarnedAt =
      (typeof ps?.captured_at === "string" && ps.captured_at) ||
      economic_earned_at_hint ||
      null;

    const existingTen = await readTripEarningNetLedgerState(supabase, trip_id);
    if (existingTen.count === 1 && existingTen.totalPence === entitlement.driver_net_pence) {
      return new Response(
        JSON.stringify({
          success: true,
          idempotent: true,
          trip_id,
          outcome,
          fee_pence: entitlement.captured_fee_pence,
          provider_fee_pence: entitlement.provider_fee_pence,
          commission_pence: 0,
          driver_net_pence: entitlement.driver_net_pence,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (existingTen.count > 1) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "DUPLICATE_TRIP_EARNING_NET",
          trip_id,
        }),
        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (
      existingTen.count === 1 &&
      existingTen.totalPence !== entitlement.driver_net_pence
    ) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "WALLET_AMOUNT_MISMATCH",
          expected_pence: entitlement.driver_net_pence,
          actual_pence: existingTen.totalPence,
          trip_id,
        }),
        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (await tripBlocksDriverWalletLedgerPosting(supabase, trip_id)) {
      console.log(
        `[record-financial-outcome] FINANCIAL_MODEL_VIOLATION — DWL forbidden ${trip_id}`,
      );
      return new Response(
        JSON.stringify({
          success: false,
          trip_id,
          outcome,
          error:
            "FINANCIAL_MODEL_VIOLATION: driver_wallet_ledger forbidden on DRIVER_COLLECTED_COMMISSION_WALLET",
          error_code: "FINANCIAL_MODEL_VIOLATION",
        }),
        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    console.log(
      `[record-financial-outcome] ${outcome} for trip ${trip_id}: ` +
        `captured=${entitlement.captured_fee_pence}p provider_fee=${entitlement.provider_fee_pence}p ` +
        `TEN=${entitlement.driver_net_pence}p commission=0` +
        `${psCaptured > 0 ? " (ps_captured)" : " (body_fee)"}, economic_earned_at=${economicEarnedAt}`,
    );

    const tripStatusMap: Record<string, string> = {
      NO_SHOW: "no_show",
      LATE_PASSENGER_CANCELLATION: "cancelled",
      AIRPORT_PROTECTION_CANCELLATION: "cancelled",
      CANCELLED_WITH_FEE: "cancelled",
    };

    // Fee stamps retain customer-captured fee; driver_net is fee-net TEN.
    const tripPatch: Record<string, unknown> = {
      status: tripStatusMap[outcome] ||
        (String(outcome).includes("NO_SHOW") ? "no_show" : "cancelled"),
      financial_outcome: outcome,
      gross_fare_pence: entitlement.captured_fee_pence,
      commission_pence: 0,
      commission_pct: 0,
      driver_net_pence: entitlement.driver_net_pence,
      driver_net_before_tip_pence: entitlement.driver_net_pence,
      cancellation_fee_pence: entitlement.captured_fee_pence,
      updated_at: new Date().toISOString(),
    };
    if (String(outcome).includes("NO_SHOW")) {
      tripPatch.no_show_charge_pence = entitlement.captured_fee_pence;
    }
    if (typeof payment_method === "string" && payment_method.trim()) {
      tripPatch.payment_method = payment_method;
    }

    await supabase
      .from("trips")
      .update(tripPatch)
      .eq("id", trip_id);

    const insertPayload = buildChargedFeeTenLedgerInsert({
      driverId: driver_id,
      tripId: trip_id,
      feePence: entitlement.driver_net_pence,
      currency: currency_code,
      outcome,
      capturedFeePence: entitlement.captured_fee_pence,
      providerFeePence: entitlement.provider_fee_pence,
    });
    // economic_earned_at is resolved by SQL from PS.captured_at — ensure PS stamp exists.
    // Do not invent created_at as economic clock.
    if (!economicEarnedAt) {
      console.warn(
        `[record-financial-outcome] PS captured_at missing for ${trip_id} — TEN posts; economic date may stay unresolved until PS stamp`,
      );
    }

    const { error: insertErr } = await supabase
      .from("driver_wallet_ledger")
      .insert(insertPayload);
    if (insertErr && insertErr.code !== "23505") {
      console.error("[record-financial-outcome] TEN insert failed", insertErr);
      return new Response(
        JSON.stringify({
          success: false,
          error: "WALLET_CREDIT_FAILED",
          message: insertErr.message,
          trip_id,
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const readback = await readTripEarningNetLedgerState(supabase, trip_id);
    if (readback.count !== 1 || readback.totalPence !== entitlement.driver_net_pence) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "WALLET_CREDIT_MISSING",
          ten_count: readback.count,
          total_pence: readback.totalPence,
          trip_id,
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    await supabase
      .from("drivers")
      .update({ current_trip_id: null })
      .eq("id", driver_id);

    return new Response(
      JSON.stringify({
        success: true,
        trip_id,
        outcome,
        fee_pence: entitlement.captured_fee_pence,
        provider_fee_pence: entitlement.provider_fee_pence,
        commission_pence: 0,
        driver_net_pence: entitlement.driver_net_pence,
        revenue_type: entitlement.revenue_type,
        currency_code,
        economic_earned_at: economicEarnedAt,
        payment_session_id: ps?.id ?? null,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("[record-financial-outcome] Error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
