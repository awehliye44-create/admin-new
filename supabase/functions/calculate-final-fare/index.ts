import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { FareEngine, type FarePricingSettings } from "../_shared/fareEngine.ts";
import { authenticateDriver } from "../_shared/driverAuth.ts";


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

    // Resolve SA distance_unit from Region (SOT) so tiered distance bands compute correctly.
    const { data: saRow } = await supabase
      .from("service_areas")
      .select("region:regions(distance_unit)")
      .eq("id", trip.service_area_id)
      .maybeSingle();
    const distanceUnit = (saRow?.region as any)?.distance_unit ?? 'km';

    const engine = new FareEngine({ ...settings, distance_unit: distanceUnit } as FarePricingSettings);
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

      case "start_paid_waiting": {
        // Called when free waiting expires — marks paid waiting as active
        const now = new Date().toISOString();
        updateData.paid_waiting_started_at = now;
        auditEvent = "paid_waiting_started";
        auditReason = `Free waiting expired, paid waiting started at rate ${settings.waiting_per_minute_pence}p/min`;
        break;
      }

      case "tick_pickup_waiting": {
        // Called periodically during pickup waiting to accumulate charges
        // Only charges if: arrived + free wait expired + trip not started
        if (!trip.arrived_at) {
          return new Response(
            JSON.stringify({ error: "Driver has not arrived yet" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const arrivedAt = new Date(trip.arrived_at);
        const freeWaitExpiresAt = trip.free_wait_expires_at
          ? new Date(trip.free_wait_expires_at)
          : new Date(arrivedAt.getTime() + settings.free_waiting_minutes * 60000);
        const tickNow = new Date();

        if (tickNow <= freeWaitExpiresAt) {
          // Still in free waiting
          return new Response(
            JSON.stringify({
              tripId: trip_id,
              action,
              in_free_waiting: true,
              free_wait_remaining_seconds: Math.ceil((freeWaitExpiresAt.getTime() - tickNow.getTime()) / 1000),
              waitingChargePence: 0,
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // Calculate total waiting from arrival
        const totalWaitMinutes = (tickNow.getTime() - arrivedAt.getTime()) / 60000;
        const result = engine.calculateWaitingCharge(totalWaitMinutes);
        adjustmentPence = result.waiting_charge_pence - waitingCharge;
        waitingCharge = result.waiting_charge_pence;
        waitingMinutes = totalWaitMinutes;
        updateData.waiting_minutes = waitingMinutes;
        updateData.waiting_charge_pence = waitingCharge;
        updateData.pickup_waiting_charge_pence = waitingCharge;

        if (!trip.paid_waiting_started_at) {
          updateData.paid_waiting_started_at = freeWaitExpiresAt.toISOString();
        }

        auditEvent = "pickup_waiting_tick";
        auditReason = `Pickup waiting: total ${totalWaitMinutes.toFixed(1)} min, billable ${result.billable_minutes} min, charge ${waitingCharge}p`;
        break;
      }

      case "check_no_show": {
        // Check if driver has waited long enough to trigger no-show
        if (!trip.arrived_at) {
          return new Response(
            JSON.stringify({ can_no_show: false, reason: "Driver has not arrived" }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const arrivedTime = new Date(trip.arrived_at);
        const checkNow = new Date();
        const waitedMinutes = (checkNow.getTime() - arrivedTime.getTime()) / 60000;
        const noShowThreshold = settings.no_show_wait_time_minutes ?? 5;
        const canNoShow = waitedMinutes >= noShowThreshold;

        return new Response(
          JSON.stringify({
            tripId: trip_id,
            can_no_show: canNoShow,
            waited_minutes: Math.floor(waitedMinutes),
            no_show_threshold_minutes: noShowThreshold,
            no_show_fee_pence: settings.no_show_fee_pence ?? 0,
            remaining_seconds: canNoShow ? 0 : Math.ceil((noShowThreshold - waitedMinutes) * 60),
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
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
