/**
 * Admin trip lifecycle SSOT — no direct trips.update from the admin UI.
 *
 * Actions:
 * - force_complete: complete trip + stops (same terminal fields as stop-workflow)
 * - reassign: move active trip to another online driver
 *
 * Returns fresh trip + stops snapshot.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, requireAdmin } from "../_shared/adminPaymentGate.ts";

const ACTIVE_STATUSES = new Set([
  "pending",
  "searching",
  "offered",
  "driver_assigned",
  "accepted",
  "confirmed",
  "arrived",
  "arrived_at_pickup",
  "arrived_pickup",
  "waiting",
  "waiting_at_pickup",
  "in_progress",
  "started",
  "on_trip",
  "ongoing",
  "en_route",
  "en_route_to_pickup",
  "enroute_to_pickup",
  "driver_en_route",
  "negotiating",
]);

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function loadSnapshot(supabase: ReturnType<typeof createClient>, tripId: string) {
  const [{ data: trip }, { data: stops }] = await Promise.all([
    supabase
      .from("trips")
      .select(
        "id, trip_code, status, dispatch_status, driver_id, confirmed_driver_id, fare, final_fare_pence, final_customer_fare_pence, completed_at, started_at, arrived_at, current_stop_index, payment_status, updated_at",
      )
      .eq("id", tripId)
      .maybeSingle(),
    supabase
      .from("trip_stops")
      .select("*")
      .eq("trip_id", tripId)
      .order("stop_index", { ascending: true }),
  ]);
  return { trip: trip ?? null, stops: stops ?? [] };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const gate = await requireAdmin(req);
  if (!gate.ok) return gate.response;

  try {
    const body = await req.json();
    const action = String(body.action ?? "").trim();
    const tripId = String(body.trip_id ?? body.tripId ?? "").trim();
    if (!tripId) return json({ success: false, error: "trip_id required" }, 400);
    if (!action) return json({ success: false, error: "action required" }, 400);

    const { data: trip, error: tripErr } = await gate.supabase
      .from("trips")
      .select("*")
      .eq("id", tripId)
      .maybeSingle();
    if (tripErr || !trip) return json({ success: false, error: "Trip not found" }, 404);

    if (action === "force_complete") {
      if (String(trip.status).toLowerCase() === "completed") {
        const snap = await loadSnapshot(gate.supabase, tripId);
        return json({ success: true, idempotent: true, action, ...snap });
      }

      const fareMajor =
        typeof body.fare === "number" && Number.isFinite(body.fare)
          ? body.fare
          : typeof body.fare_amount === "number" && Number.isFinite(body.fare_amount)
            ? body.fare_amount
            : Number(trip.fare ?? trip.estimated_fare ?? 0);
      const farePence = Math.max(0, Math.round(fareMajor * 100));
      const now = new Date().toISOString();
      const note =
        typeof body.reason === "string" && body.reason.trim()
          ? body.reason.trim()
          : `Force ended by admin. Final fare: ${fareMajor}`;

      await gate.supabase
        .from("trip_stops")
        .update({
          status: "completed",
          completed_at: now,
          arrived_at: now,
          waiting_charge_active: false,
        })
        .eq("trip_id", tripId)
        .neq("status", "completed");

      const { error: tripUpdateErr } = await gate.supabase
        .from("trips")
        .update({
          status: "completed",
          dispatch_status: "completed",
          fare: fareMajor,
          final_fare_pence: farePence,
          final_customer_fare_pence: farePence,
          completed_at: now,
          special_instructions: note,
          updated_at: now,
        })
        .eq("id", tripId);
      if (tripUpdateErr) {
        return json({ success: false, error: tripUpdateErr.message }, 500);
      }

      if (trip.driver_id) {
        await gate.supabase
          .from("drivers")
          .update({ current_trip_id: null })
          .eq("id", trip.driver_id)
          .eq("current_trip_id", tripId);
      }

      const snap = await loadSnapshot(gate.supabase, tripId);
      return json({ success: true, action, ...snap });
    }

    if (action === "reassign") {
      const newDriverId = String(body.driver_id ?? body.new_driver_id ?? "").trim();
      if (!newDriverId) return json({ success: false, error: "driver_id required" }, 400);

      const status = String(trip.status ?? "").toLowerCase();
      if (!ACTIVE_STATUSES.has(status)) {
        return json({
          success: false,
          error: `Trip status ${trip.status} cannot be reassigned`,
          code: "INVALID_STATE",
        }, 409);
      }

      const { data: newDriver, error: drvErr } = await gate.supabase
        .from("drivers")
        .select("id, is_online, approval_status, current_trip_id")
        .eq("id", newDriverId)
        .maybeSingle();
      if (drvErr || !newDriver) {
        return json({ success: false, error: "Driver not found" }, 404);
      }
      if (newDriver.approval_status !== "approved") {
        return json({ success: false, error: "Driver is not approved" }, 409);
      }
      if (newDriver.current_trip_id && newDriver.current_trip_id !== tripId) {
        return json({
          success: false,
          error: "Driver already has an active trip",
          code: "DRIVER_BUSY",
        }, 409);
      }

      const oldDriverId = trip.driver_id as string | null;
      const now = new Date().toISOString();

      const { error: tripUpdateErr } = await gate.supabase
        .from("trips")
        .update({
          driver_id: newDriverId,
          confirmed_driver_id: newDriverId,
          status: "driver_assigned",
          dispatch_status: "assigned",
          updated_at: now,
        })
        .eq("id", tripId);
      if (tripUpdateErr) {
        return json({ success: false, error: tripUpdateErr.message }, 500);
      }

      if (oldDriverId && oldDriverId !== newDriverId) {
        await gate.supabase
          .from("drivers")
          .update({ current_trip_id: null })
          .eq("id", oldDriverId)
          .eq("current_trip_id", tripId);
      }
      await gate.supabase
        .from("drivers")
        .update({ current_trip_id: tripId })
        .eq("id", newDriverId);

      const snap = await loadSnapshot(gate.supabase, tripId);
      return json({ success: true, action, ...snap });
    }

    return json({
      success: false,
      error: "Unknown action",
      allowed: ["force_complete", "reassign"],
    }, 400);
  } catch (e) {
    console.error("[admin-trip-action]", e);
    return json({
      success: false,
      error: e instanceof Error ? e.message : "Internal error",
    }, 500);
  }
});
