import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { FareEngine, type FarePricingSettings } from "../_shared/fareEngine.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const { trip_id, action, payload } = await req.json();

    if (!trip_id) {
      return new Response(
        JSON.stringify({ error: "Missing trip_id" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fetch the trip
    const { data: trip, error: tripError } = await supabase
      .from("trips")
      .select("*")
      .eq("id", trip_id)
      .single();

    if (tripError || !trip) {
      return new Response(
        JSON.stringify({ error: "Trip not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fetch fare pricing settings
    const { data: settings, error: settingsErr } = await supabase
      .from("fare_pricing_settings")
      .select("*")
      .eq("service_area_id", trip.service_area_id)
      .single();

    if (settingsErr || !settings) {
      return new Response(
        JSON.stringify({ error: "Fare pricing settings not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const engine = new FareEngine(settings as FarePricingSettings);
    const quotedFare = trip.quoted_fare_pence || trip.estimated_total_pence || 0;
    let waitingCharge = trip.waiting_charge_pence || 0;
    let stopChargeTotal = trip.stop_charge_total_pence || 0;
    let destChangeAdj = trip.destination_change_adjustment_pence || 0;
    let waitingMinutes = trip.waiting_minutes || 0;

    const updateData: Record<string, unknown> = {};
    let auditEvent: string | null = null;
    let auditReason = "";
    let adjustmentPence = 0;

    switch (action) {
      case "apply_waiting": {
        const newWaitingMinutes = payload?.waiting_minutes ?? 0;
        const result = engine.calculateWaitingCharge(newWaitingMinutes);
        adjustmentPence = result.waiting_charge_pence - waitingCharge;
        waitingCharge = result.waiting_charge_pence;
        waitingMinutes = newWaitingMinutes;
        updateData.waiting_minutes = waitingMinutes;
        updateData.waiting_charge_pence = waitingCharge;
        auditEvent = "waiting_charge_applied";
        auditReason = `Waiting ${newWaitingMinutes} min (free: ${settings.free_waiting_minutes} min), billable: ${result.billable_minutes} min`;
        break;
      }

      case "add_stop": {
        const addDistKm = payload?.additional_distance_km ?? 0;
        const addDurMin = payload?.additional_duration_min ?? 0;
        const result = engine.calculateStopAdjustment(addDistKm, addDurMin);
        adjustmentPence = result.total_adjustment_pence;
        stopChargeTotal += result.total_adjustment_pence;
        updateData.stop_charge_total_pence = stopChargeTotal;
        auditEvent = "stop_added";
        auditReason = `Stop added: flat=${result.flat_fee_pence}p, dist=${result.distance_charge_pence}p, time=${result.time_charge_pence}p`;
        break;
      }

      case "change_destination": {
        const newDistKm = payload?.new_estimated_distance_km ?? 0;
        const newDurMin = payload?.new_estimated_duration_min ?? 0;
        const result = engine.calculateDestinationAdjustment(quotedFare, newDistKm, newDurMin);
        adjustmentPence = result.adjustment_pence;
        destChangeAdj += result.adjustment_pence;
        updateData.destination_change_adjustment_pence = destChangeAdj;
        auditEvent = "destination_changed";
        auditReason = `Destination changed: old=${result.old_route_fare_pence}p, new=${result.new_route_fare_pence}p, adj=${result.adjustment_pence}p`;
        break;
      }

      case "finalize": {
        // Calculate final fare
        auditEvent = "trip_finalized";
        auditReason = "Trip completed, final fare calculated";
        break;
      }

      default:
        return new Response(
          JSON.stringify({ error: `Unknown action: ${action}` }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }

    // Calculate final fare
    const finalFare = engine.calculateFinalFare(
      quotedFare,
      waitingMinutes,
      stopChargeTotal,
      destChangeAdj
    );

    updateData.final_fare_pence = finalFare;
    updateData.fare_breakdown = {
      quoted_fare_pence: quotedFare,
      waiting_charge_pence: waitingCharge,
      stop_charge_total_pence: stopChargeTotal,
      destination_change_adjustment_pence: destChangeAdj,
      final_fare_pence: finalFare,
    };

    // Update trip
    const { error: updateErr } = await supabase
      .from("trips")
      .update(updateData)
      .eq("id", trip_id);

    if (updateErr) {
      console.error("Failed to update trip:", updateErr);
      return new Response(
        JSON.stringify({ error: "Failed to update trip fare" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Create fare audit log
    if (auditEvent) {
      const oldFare = trip.final_fare_pence || quotedFare;
      await supabase.from("fare_audit_logs").insert({
        trip_id,
        event_type: auditEvent,
        old_fare_pence: oldFare,
        adjustment_pence: adjustmentPence,
        new_fare_pence: finalFare,
        reason: auditReason,
        metadata: { action, payload, settings_snapshot: { pricing_mode: settings.pricing_mode } },
      });
    }

    return new Response(
      JSON.stringify({
        tripId: trip_id,
        action,
        quotedFarePence: quotedFare,
        waitingChargePence: waitingCharge,
        stopChargeTotalPence: stopChargeTotal,
        destinationChangeAdjustmentPence: destChangeAdj,
        finalFarePence: finalFare,
        currencyCode: settings.currency_code,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("calculate-final-fare error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
