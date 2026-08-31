/**
 * Admin trip lifecycle SSOT — no direct trips.update from the admin UI.
 *
 * Actions:
 * - force_complete: complete trip + stops (same terminal fields as stop-workflow)
 * - reassign: move active trip to another online driver
 * - notify_driver_assigned: Customer driver_assigned lifecycle WAV after admin
 *   pre-assign (Manual Trip / ScheduledRides) — never mute
 *
 * Returns fresh trip + stops snapshot.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, requireAdmin } from "../_shared/adminPaymentGate.ts";
import {
  convertCommissionWalletOnTripComplete,
  ensureCommissionWalletDeductionForCompletedTrip,
} from "../_shared/commissionWalletDeduction.ts";
import { tripUsesCommissionWalletDeduction } from "../_shared/commissionWalletSSOT.ts";
import { calculateTripSettlement, resolveTripTierPercent, tripSettlementDbColumns } from "../_shared/tripSettlement.ts";
import { notifyCustomerTripLifecycle } from "../_shared/customerTripLifecycleNotify.ts";

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
        let cwDeductionRepaired = false;
        if (trip.driver_id) {
          const repair = await ensureCommissionWalletDeductionForCompletedTrip({
            supabase: gate.supabase,
            tripId,
            driverId: String(trip.driver_id),
          });
          cwDeductionRepaired = repair.repaired === true;
          if (cwDeductionRepaired) {
            console.log("[admin-trip-action] COMMISSION_WALLET_DEDUCTION repaired on idempotent force_complete", {
              trip_id: tripId,
              result: repair.raw,
            });
          }
        }
        const snap = await loadSnapshot(gate.supabase, tripId);
        return json({
          success: true,
          idempotent: true,
          action,
          cw_deduction_repaired: cwDeductionRepaired,
          ...snap,
        });
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

      const tierPct = resolveTripTierPercent({
        accepted_commission_percent: trip.accepted_commission_percent,
        driver_tier_commission_percent: trip.driver_tier_commission_percent,
        commission_pct: trip.commission_pct,
      });
      const settlement = calculateTripSettlement({
        final_fare_pence: farePence,
        airport_charge_pence: Number(trip.airport_charge_pence ?? 0),
        other_pass_through_charges_pence: Number(
          trip.other_pass_through_charges_pence ?? 0,
        ),
        tips_pence: Number(trip.tip_amount_pence ?? trip.tip_pence ?? 0),
        driver_tier_commission_percent: tierPct,
      });

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
          ...tripSettlementDbColumns(settlement),
          tip_amount_pence: settlement.tips_pence,
          tip_pence: settlement.tips_pence,
        })
        .eq("id", tripId);
      if (tripUpdateErr) {
        return json({ success: false, error: tripUpdateErr.message }, 500);
      }

      // After authoritative force_complete — Customer trip_completed lifecycle push/WAV.
      const passengerIdComplete =
        typeof trip.passenger_id === "string" ? trip.passenger_id : null;
      if (passengerIdComplete) {
        void notifyCustomerTripLifecycle(gate.supabase, {
          passengerId: passengerIdComplete,
          tripId,
          event: "trip_completed",
        }).catch((e) =>
          console.warn("[admin-trip-action] customer trip_completed push failed:", e)
        );
      }

      if (trip.driver_id) {
        await gate.supabase
          .from("drivers")
          .update({ current_trip_id: null })
          .eq("id", trip.driver_id)
          .eq("current_trip_id", tripId);

        // Phase 7: CW completion deduction (no driver_wallet_ledger / payout liability).
        const usesCw = tripUsesCommissionWalletDeduction({
          tripFinancialModel: trip.financial_model,
          tripCommissionWalletEnabled: trip.commission_wallet_enabled,
        });
        if (usesCw) {
          const cwDeduction = await convertCommissionWalletOnTripComplete({
            supabase: gate.supabase,
            driverId: String(trip.driver_id),
            tripId,
            commissionMinor: settlement.commission_pence,
            commissionableFareMinor: settlement.commissionable_fare_pence,
            commissionRateBps: Math.round(settlement.tier_percent_used * 100),
          });
          console.log("[admin-trip-action] COMMISSION_WALLET_DEDUCTION", {
            trip_id: tripId,
            result: cwDeduction.raw,
          });
          if (!cwDeduction.ok) {
            console.error("[admin-trip-action] CW deduction failed after force_complete", cwDeduction);
          }
          const snap = await loadSnapshot(gate.supabase, tripId);
          return json({
            success: true,
            action,
            uses_commission_wallet: true,
            cw_deduction_ok: cwDeduction.ok === true,
            cw_deduction_code: cwDeduction.code ?? null,
            financial_ok: cwDeduction.ok === true,
            ...snap,
          });
        }
      }

      const snap = await loadSnapshot(gate.supabase, tripId);
      return json({ success: true, action, financial_ok: true, ...snap });
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

      // Phase 6: soft-check CW reserve before hard trigger (UK / reserve-off returns true).
      const { data: passesCwGate, error: cwGateErr } = await gate.supabase.rpc(
        "driver_passes_commission_wallet_dispatch_gate",
        { p_driver_id: newDriverId, p_trip_id: tripId },
      );
      if (cwGateErr) {
        return json({
          success: false,
          error: cwGateErr.message,
          code: "COMMISSION_WALLET_GATE_CHECK_FAILED",
        }, 500);
      }
      if (passesCwGate === false) {
        return json({
          success: false,
          error: "Driver has insufficient commission wallet balance for this trip",
          code: "INSUFFICIENT_COMMISSION_WALLET_BALANCE",
        }, 409);
      }

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
        const msg = String(tripUpdateErr.message ?? "");
        if (msg.includes("INSUFFICIENT_COMMISSION_WALLET_BALANCE")) {
          return json({
            success: false,
            error: "Driver has insufficient commission wallet balance for this trip",
            code: "INSUFFICIENT_COMMISSION_WALLET_BALANCE",
          }, 409);
        }
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

      // After authoritative reassign — Customer driver_assigned lifecycle push/WAV.
      const passengerIdReassign =
        typeof trip.passenger_id === "string" ? trip.passenger_id : null;
      if (passengerIdReassign) {
        void notifyCustomerTripLifecycle(gate.supabase, {
          passengerId: passengerIdReassign,
          tripId,
          event: "new_driver_assigned",
          body: "A new driver has been assigned to your trip.",
        }).catch((e) =>
          console.warn("[admin-trip-action] customer driver_assigned push failed:", e)
        );
      }

      const snap = await loadSnapshot(gate.supabase, tripId);
      return json({ success: true, action, ...snap });
    }

    if (action === "notify_driver_assigned") {
      const passengerId =
        typeof trip.passenger_id === "string" ? trip.passenger_id.trim() : "";
      if (!passengerId) {
        return json({ success: false, error: "Trip has no passenger_id" }, 409);
      }
      const title =
        typeof body.title === "string" && body.title.trim()
          ? body.title.trim()
          : undefined;
      const notifyBody =
        typeof body.body === "string" && body.body.trim()
          ? body.body.trim()
          : undefined;
      const notificationId =
        typeof body.notification_id === "string" && body.notification_id.trim()
          ? body.notification_id.trim()
          : `driver_assigned-${tripId}-admin`;
      await notifyCustomerTripLifecycle(gate.supabase, {
        passengerId,
        tripId,
        event: "driver_assigned",
        ...(title ? { title } : {}),
        ...(notifyBody ? { body: notifyBody } : {}),
        notificationId,
      });
      return json({ success: true, action, trip_id: tripId });
    }

    return json({
      success: false,
      error: "Unknown action",
      allowed: ["force_complete", "reassign", "notify_driver_assigned"],
    }, 400);
  } catch (e) {
    console.error("[admin-trip-action]", e);
    return json({
      success: false,
      error: e instanceof Error ? e.message : "Internal error",
    }, 500);
  }
});
