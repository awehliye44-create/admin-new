import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  releaseRevolutPreauthForTrip,
  resolveRevolutOrderIdFromTrip,
} from "../_shared/revolutPreauthReleaseSSOT.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const log = (step: string, details?: unknown) => {
  const d = details ? ` - ${JSON.stringify(details)}` : "";
  console.log(`[CHARGE-LIFECYCLE-FEE] ${step}${d}`);
};

type FeeType =
  | "cancellation"
  | "late_cancel"
  | "no_show"
  | "waiting_surcharge"
  | "arrival_cancellation";

/**
 * Unified lifecycle fee charger (Revolut-only money path).
 *
 * Modes:
 *   A) amount_pence provided → charge that exact amount (caller pre-calculated)
 *   B) amount_pence NOT provided → read fare_pricing_settings and calculate
 *
 * Body: { trip_id, fee_type, amount_pence? (optional), description? }
 *
 * Revolut: same-order partial capture via releaseRevolutPreauthForTrip, then residual release.
 * Non-Revolut card paths are unavailable.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  try {
    const body = await req.json();
    const { trip_id, fee_type, description } = body;
    let { amount_pence } = body;

    if (!trip_id || !fee_type) {
      return new Response(
        JSON.stringify({ error: "trip_id and fee_type are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const validFeeTypes: FeeType[] = [
      "cancellation",
      "late_cancel",
      "no_show",
      "waiting_surcharge",
      "arrival_cancellation",
    ];
    if (!validFeeTypes.includes(fee_type)) {
      return new Response(
        JSON.stringify({ error: `Invalid fee_type. Must be one of: ${validFeeTypes.join(", ")}` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    log("Request", { trip_id, fee_type, amount_pence });

    const { data: existingCharge } = await supabase
      .from("payments")
      .select("id")
      .eq("trip_id", trip_id)
      .eq("fee_type", fee_type)
      .in("status", ["captured", "succeeded", "capture_requested"])
      .maybeSingle();

    if (existingCharge) {
      log("Duplicate — already charged", { existingId: existingCharge.id });
      return new Response(
        JSON.stringify({ success: true, already_charged: true, payment_id: existingCharge.id }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { data: trip, error: tripErr } = await supabase
      .from("trips")
      .select(
        "id, passenger_id, service_area_id, vehicle_type_id, currency_code, arrived_at, created_at, scheduled_at, payment_method, payment_provider, provider_order_id, status, financial_model",
      )
      .eq("id", trip_id)
      .single();

    if (tripErr || !trip) {
      return new Response(JSON.stringify({ error: "Trip not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (
      String(trip.financial_model ?? "").toUpperCase()
      === "DRIVER_COLLECTED_COMMISSION_WALLET"
    ) {
      log("Rejected — DRIVER_COLLECTED trips cannot use platform lifecycle capture");
      return new Response(JSON.stringify({
        success: false,
        error: "FINANCIAL_MODEL_VIOLATION: platform capture forbidden on DRIVER_COLLECTED_COMMISSION_WALLET",
        error_code: "FINANCIAL_MODEL_VIOLATION",
      }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (trip.payment_method === "wallet") {
      log("Wallet payment method not supported for lifecycle fees");
      return new Response(
        JSON.stringify({ success: false, error: "Wallet payment method is disabled" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (!amount_pence || amount_pence <= 0) {
      log("No amount_pence provided — calculating from fare_pricing_settings");

      let pricingRules: Record<string, unknown> | null = null;

      if (trip.service_area_id) {
        if (trip.vehicle_type_id) {
          const { data } = await supabase
            .from("fare_pricing_settings")
            .select(
              "cancellation_fee_pence, cancellation_grace_period_minutes, cancellation_apply_after_arrival_only, free_waiting_minutes, late_cancel_enabled, late_cancel_threshold_minutes, late_cancel_fee_pence, no_show_fee_pence, no_show_wait_time_minutes, no_show_apply_after_arrival_only, waiting_per_minute_pence, arrival_cancellation_enabled, arrival_cancellation_fee_pence",
            )
            .eq("service_area_id", trip.service_area_id)
            .eq("vehicle_type_id", trip.vehicle_type_id)
            .maybeSingle();
          if (data) pricingRules = data as Record<string, unknown>;
        }

        if (!pricingRules) {
          const { data } = await supabase
            .from("fare_pricing_settings")
            .select(
              "cancellation_fee_pence, cancellation_grace_period_minutes, cancellation_apply_after_arrival_only, free_waiting_minutes, late_cancel_enabled, late_cancel_threshold_minutes, late_cancel_fee_pence, no_show_fee_pence, no_show_wait_time_minutes, no_show_apply_after_arrival_only, waiting_per_minute_pence, arrival_cancellation_enabled, arrival_cancellation_fee_pence",
            )
            .eq("service_area_id", trip.service_area_id)
            .limit(1)
            .maybeSingle();
          if (data) pricingRules = data as Record<string, unknown>;
        }
      }

      if (!pricingRules) {
        log("No fare_pricing_settings found — cannot calculate fee");
        return new Response(
          JSON.stringify({
            success: false,
            error: "No pricing configuration found for this service area",
            amount_pence: 0,
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      switch (fee_type as FeeType) {
        case "cancellation":
          amount_pence = (pricingRules.cancellation_fee_pence as number) || 0;
          break;
        case "late_cancel": {
          const enabled = (pricingRules.late_cancel_enabled as boolean) ?? false;
          amount_pence = enabled ? ((pricingRules.late_cancel_fee_pence as number) || 0) : 0;
          break;
        }
        case "no_show":
          amount_pence = (pricingRules.no_show_fee_pence as number) || 0;
          break;
        case "waiting_surcharge":
          log("waiting_surcharge requires amount_pence from caller");
          amount_pence = 0;
          break;
        case "arrival_cancellation": {
          const enabled = (pricingRules.arrival_cancellation_enabled as boolean) ?? true;
          amount_pence = enabled
            ? ((pricingRules.arrival_cancellation_fee_pence as number) || 0)
            : 0;
          break;
        }
      }

      log("Calculated fee from pricing settings", { fee_type, amount_pence });
    }

    if (!amount_pence || amount_pence <= 0) {
      log("Fee amount is 0 — nothing to charge");
      return new Response(
        JSON.stringify({ success: true, charged: false, amount_pence: 0, fee_type, reason: "fee_is_zero" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const revolutOrderId = resolveRevolutOrderIdFromTrip(trip as Record<string, unknown>);
    if (revolutOrderId) {
      log("Revolut lifecycle fee path", { trip_id, fee_type, amount_pence, revolutOrderId });
      const revolutRelease = await releaseRevolutPreauthForTrip(supabase, {
        tripId: trip_id,
        providerOrderId: revolutOrderId,
        reason: description || `lifecycle_${fee_type}`,
        stage: `charge_lifecycle_fee:${fee_type}`,
        feePence: amount_pence,
        idempotencyKey: `lifecycle_${fee_type}_${trip_id}`,
        holdTerminalReason: fee_type,
      });

      const feeCaptured = Math.max(0, Math.round(revolutRelease.fee_captured_pence ?? 0));
      const charged =
        feeCaptured > 0 ||
        revolutRelease.status === "fee_charged" ||
        revolutRelease.status === "captured";

      const currency = trip.currency_code?.toLowerCase() || "gbp";
      if (charged) {
        await supabase.from("payments").insert({
          trip_id,
          fee_type,
          payment_provider: "revolut",
          provider_order_id: revolutOrderId,
          status: "captured",
          amount_pence: feeCaptured || amount_pence,
          currency,
          capture_method: "revolut_partial_capture",
          metadata: {
            description: description || fee_type,
            charge_method: "revolut_partial_capture",
            revolut_status: revolutRelease.status,
          },
        });

        const feeColumn: Record<string, string> = {
          cancellation: "cancellation_fee_pence",
          late_cancel: "cancellation_fee_pence",
          no_show: "no_show_charge_pence",
          waiting_surcharge: "waiting_charge_pence",
          arrival_cancellation: "arrival_cancellation_fee",
        };
        const col = feeColumn[fee_type];
        if (col) {
          await supabase
            .from("trips")
            .update({ [col]: feeCaptured || amount_pence })
            .eq("id", trip_id);
        }
      }

      log("Revolut lifecycle fee result", { trip_id, fee_type, charged, revolutRelease });
      return new Response(
        JSON.stringify({
          success: true,
          charged,
          already_charged: false,
          provider: "revolut",
          provider_order_id: revolutOrderId,
          amount_pence: feeCaptured || amount_pence,
          fee_type,
          revolut_status: revolutRelease.status,
          released: revolutRelease.released,
          error: revolutRelease.error,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // No Revolut order — cannot charge lifecycle fee.
    return new Response(
      JSON.stringify({
        success: false,
        error: "No Revolut payment order on trip",
        error_code: "PAYMENT_PROVIDER_UNAVAILABLE",
        message: "No Revolut payment order on trip",
      }),
      { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log("ERROR", { message: msg });
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
