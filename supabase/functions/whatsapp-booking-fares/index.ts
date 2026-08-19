/**
 * whatsapp-booking-fares
 *
 * Returns authoritative per-vehicle fares for the WhatsApp external booking channel,
 * using the same canonical `calculate-fare` SSOT as the Customer app.
 *
 * Request:
 *   POST { service_area_id, estimated_distance_km, estimated_duration_min,
 *           pickup?: { lat, lng }, dropoff?: { lat, lng } }
 *
 * Response:
 *   { success, financial_model, booking_workflow, currencyCode, distanceUnit,
 *     paymentMethods, vehicleFares, skip_platform_preauth }
 *
 * The caller MUST branch on `booking_workflow`:
 *   "platform_collected"  → show digital payment methods, create Payment Session
 *   "driver_collected"    → no Payment Session/preauth, driver-collected UX
 *   "unavailable"         → do not create trip; show safe unavailable message
 *
 * No WhatsApp-specific pricing logic — this is a thin proxy to calculate-fare.
 */

import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { corsHeaders } from "../_shared/corsHeaders.ts";
import {
  classifyServiceAreaFinancialPairing,
  shouldSkipPlatformPreauthForCommissionWallet,
  type ServiceAreaCommissionWalletConfig,
} from "../_shared/commissionWalletSSOT.ts";

interface FareRequest {
  service_area_id: string;
  estimated_distance_km: number;
  estimated_duration_min: number;
  pickup?: { lat: number; lng: number };
  dropoff?: { lat: number; lng: number };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const respond = (payload: Record<string, unknown>) =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const body: FareRequest = await req.json().catch(() => ({} as FareRequest));
    const { service_area_id, estimated_distance_km, estimated_duration_min, pickup, dropoff } = body;

    if (!service_area_id) {
      return respond({ success: false, error: "service_area_id is required" });
    }
    if (typeof estimated_distance_km !== "number" || typeof estimated_duration_min !== "number") {
      return respond({ success: false, error: "estimated_distance_km and estimated_duration_min are required" });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // 1. Verify service area exists and read financial model — fail closed on unknown/invalid config.
    const { data: saRow, error: saErr } = await supabase
      .from("service_areas")
      .select("id, financial_model, commission_wallet_enabled, customer_payment_policy")
      .eq("id", service_area_id)
      .eq("is_active", true)
      .maybeSingle();
    if (saErr) throw new Error(saErr.message);
    if (!saRow) {
      return respond({ success: false, error: "Service area not found or inactive", booking_workflow: "unavailable" });
    }

    const saConfig: ServiceAreaCommissionWalletConfig = {
      financial_model: saRow.financial_model,
      commission_wallet_enabled: saRow.commission_wallet_enabled,
      customer_payment_policy: saRow.customer_payment_policy,
    };
    const saPairing = classifyServiceAreaFinancialPairing(saConfig);

    // Fail closed — INVALID financial/payment config must never create a trip.
    if (!saPairing.ok) {
      console.error(
        `[whatsapp-booking-fares] Invalid financial config for SA ${service_area_id}:`,
        saRow.financial_model, saRow.customer_payment_policy, saRow.commission_wallet_enabled,
      );
      return respond({
        success: false,
        error: "INVALID_FINANCIAL_CONFIG",
        message: "This service area has an invalid payment configuration. Booking is unavailable.",
        booking_workflow: "unavailable",
        financial_model: null,
      });
    }

    const financial_model = saPairing.financial_model;
    const customer_payment_policy = saPairing.customer_payment_policy;
    const skip_platform_preauth = shouldSkipPlatformPreauthForCommissionWallet(saConfig);
    const booking_workflow = skip_platform_preauth ? "driver_collected" : "platform_collected";

    // 2. Fetch payment methods for this service area (only meaningful for platform_collected).
    const { data: pmRow } = await supabase
      .from("service_area_payment_methods")
      .select("card_enabled, wallet_enabled, apple_pay_enabled, google_pay_enabled")
      .eq("service_area_id", service_area_id)
      .maybeSingle();

    const paymentMethods = pmRow
      ? {
          card: pmRow.card_enabled ?? true,
          wallet: pmRow.wallet_enabled ?? false,
          applePay: pmRow.apple_pay_enabled ?? false,
          googlePay: pmRow.google_pay_enabled ?? false,
        }
      : { card: true, wallet: false, applePay: false, googlePay: false };

    // For DRIVER_COLLECTED, no digital payment methods are shown to the customer.
    const effectivePaymentMethods = skip_platform_preauth
      ? { card: false, wallet: false, applePay: false, googlePay: false }
      : paymentMethods;

    // 3. Call calculate-fare SSOT — identical call shape to the Customer app.
    //    Returns per-vehicle authoritative fares including zones, surge, airport charges.
    const calculateFareUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/calculate-fare`;
    const fareReqBody: Record<string, unknown> = {
      service_area_id,
      estimated_distance_km,
      estimated_duration_min,
    };
    if (pickup) fareReqBody.pickup = pickup;
    if (dropoff) fareReqBody.dropoff = dropoff;

    const fareRes = await fetch(calculateFareUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        apikey: Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      },
      body: JSON.stringify(fareReqBody),
    });

    if (!fareRes.ok) {
      throw new Error(`calculate-fare HTTP ${fareRes.status}`);
    }
    const farePayload = await fareRes.json() as Record<string, unknown>;
    if (!farePayload.success) {
      return respond({
        success: false,
        error: farePayload.error ?? "Fare calculation failed",
        booking_workflow,
        financial_model,
        customer_payment_policy,
      });
    }

    console.log(
      `[whatsapp-booking-fares] sa=${service_area_id} model=${financial_model} workflow=${booking_workflow}`,
      `fares=${(farePayload.vehicleFares as unknown[])?.length ?? 0}`,
    );

    return respond({
      success: true,
      financial_model,
      customer_payment_policy,
      booking_workflow,
      skip_platform_preauth,
      currencyCode: farePayload.currencyCode,
      distanceUnit: farePayload.distanceUnit,
      paymentMethods: effectivePaymentMethods,
      vehicleFares: farePayload.vehicleFares,
    });
  } catch (err) {
    console.error("[whatsapp-booking-fares] error:", err);
    return new Response(
      JSON.stringify({ success: false, error: err instanceof Error ? err.message : "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
