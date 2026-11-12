/**
 * Phase 3 — Admin emergency scheduled-ride actions (backend-gated).
 * Make Available / Broadcast / exceptional hold — never client-mutate marketplace fields.
 */
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  corsHeaders,
  requireAdmin,
  requireAnyPageAccess,
} from "../_shared/adminPaymentGate.ts";
import { assertPaymentGate, PaymentGateError } from "../_shared/paymentGate.ts";
import {
  buildAssignNowPatch,
  buildBroadcastNowPatch,
  buildMakeAvailableScheduledJobsPatch,
  buildPendingReleasePatch,
  clearPendingReleasePatch,
} from "../_shared/scheduledAdminReleaseSSOT.ts";
import { assertAirportPricingReady } from "../_shared/scheduledMarketplaceHoldSSOT.ts";
import { notifyScheduledMarketplaceOpen } from "../_shared/scheduledMarketplaceNotifySSOT.ts";
import { resolveScheduledDispatchConfig } from "../_shared/scheduledDispatchConfig.ts";
import { maxBroadcastSequences } from "../_shared/dispatch-settings.ts";
import { TERMINAL_TRIP_STATUS_POSTGREST_LIST } from "../_shared/tripTerminalDispatch.ts";

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const ACTIONS = new Set([
  "make_available_now",
  "make_available_at",
  "broadcast_now",
  "broadcast_at",
  "assign_at",
  "cancel_pending_release",
  "hold_exceptional",
]);

async function audit(
  supabase: ReturnType<typeof createClient>,
  input: {
    adminUserId: string;
    action: string;
    tripId: string;
    reason: string;
    previous: Record<string, unknown>;
    resulting: Record<string, unknown>;
  },
) {
  try {
    await supabase.from("audit_logs").insert({
      event_type: `ADMIN_SCHEDULED_${input.action.toUpperCase()}`,
      actor_user_id: input.adminUserId,
      trip_id: input.tripId,
      details: {
        reason: input.reason,
        previous: input.previous,
        resulting: input.resulting,
        at: new Date().toISOString(),
      },
    });
  } catch (e) {
    console.warn("[admin-scheduled-ride-action] audit insert failed", e);
  }
}

function snapshot(trip: Record<string, unknown>) {
  return {
    scheduled_status: trip.scheduled_status ?? null,
    status: trip.status ?? null,
    scheduled_broadcast_at: trip.scheduled_broadcast_at ?? null,
    broadcast_enabled: trip.broadcast_enabled ?? null,
    scheduled_hold_reason: trip.scheduled_hold_reason ?? null,
    pending_release_kind: trip.pending_release_kind ?? null,
    pending_release_at: trip.pending_release_at ?? null,
    confirmed_driver_id: trip.confirmed_driver_id ?? null,
    driver_id: trip.driver_id ?? null,
    dispatch_mode: trip.dispatch_mode ?? null,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const adminGate = await requireAdmin(req);
  if (!adminGate.ok) return adminGate.response;
  const gate = await requireAnyPageAccess(adminGate, ["scheduled-rides"]);
  if (!gate.ok) return gate.response;

  try {
    const body = await req.json();
    const action = String(body.action ?? "").trim();
    const tripId = String(body.trip_id ?? body.tripId ?? "").trim();
    const reason = String(body.reason ?? "").trim();
    if (!tripId) return json({ success: false, error: "trip_id required" }, 400);
    if (!ACTIONS.has(action)) {
      return json({ success: false, error: `Unsupported action: ${action}` }, 400);
    }
    if (reason.length < 3) {
      return json({ success: false, error: "reason required (min 3 chars)" }, 400);
    }

    const { data: trip, error: tripErr } = await gate.supabase
      .from("trips")
      .select("*")
      .eq("id", tripId)
      .maybeSingle();
    if (tripErr || !trip) return json({ success: false, error: "Trip not found" }, 404);

    const previous = snapshot(trip);
    const now = new Date();
    const nowIso = now.toISOString();
    const adminUserId = String(
      (gate as { userId?: string }).userId ??
        (adminGate as { userId?: string }).userId ??
        "",
    );

    if (action === "hold_exceptional") {
      const { data: rows, error } = await gate.supabase
        .from("trips")
        .update({
          scheduled_status: "admin_held",
          scheduled_broadcast_at: null,
          scheduled_hold_reason: "admin_exceptional",
          ...clearPendingReleasePatch(),
          updated_at: nowIso,
        })
        .eq("id", tripId)
        .is("driver_id", null)
        .is("completed_at", null)
        .not("status", "in", TERMINAL_TRIP_STATUS_POSTGREST_LIST)
        .select("id, scheduled_status, scheduled_hold_reason, scheduled_broadcast_at, broadcast_enabled");
      if (error) return json({ success: false, error: error.message }, 500);
      if (!rows?.length) {
        return json({ success: false, error: "Trip no longer eligible for exceptional hold" }, 409);
      }
      await audit(gate.supabase, {
        adminUserId,
        action,
        tripId,
        reason,
        previous,
        resulting: snapshot(rows[0]),
      });
      return json({ success: true, action, trip_id: tripId });
    }

    if (action === "cancel_pending_release") {
      const { data: rows, error } = await gate.supabase
        .from("trips")
        .update({ ...clearPendingReleasePatch(), updated_at: nowIso })
        .eq("id", tripId)
        .select("id, pending_release_kind, pending_release_at");
      if (error) return json({ success: false, error: error.message }, 500);
      await audit(gate.supabase, {
        adminUserId,
        action,
        tripId,
        reason,
        previous,
        resulting: snapshot({ ...trip, ...(rows?.[0] ?? {}) }),
      });
      return json({ success: true, action, trip_id: tripId });
    }

    // All publication / broadcast paths: airport + payment gates (backend).
    const airport = assertAirportPricingReady({
      broadcastEnabled: trip.broadcast_enabled,
      airportChargePence: trip.airport_charge_pence,
    });
    if (!airport.ok) {
      return json({
        success: false,
        error: "AIRPORT_PRICING_UNRESOLVED",
        message: "Cannot publish or broadcast while mandatory airport pricing is unresolved.",
      }, 409);
    }

    try {
      await assertPaymentGate(gate.supabase, tripId);
    } catch (gateErr) {
      const detail = gateErr instanceof PaymentGateError
        ? gateErr.message
        : String((gateErr as Error)?.message ?? gateErr);
      return json({
        success: false,
        error: "PAYMENT_GATE_NOT_SATISFIED",
        message: detail,
      }, 409);
    }

    if (action === "make_available_now") {
      const { data: rows, error } = await gate.supabase
        .from("trips")
        .update({
          ...buildMakeAvailableScheduledJobsPatch({ nowIso }),
          scheduled_hold_reason: null,
        })
        .eq("id", tripId)
        .is("driver_id", null)
        .is("confirmed_driver_id", null)
        .is("completed_at", null)
        .in("scheduled_status", ["admin_held", "scheduled", "pending"])
        .not("status", "in", TERMINAL_TRIP_STATUS_POSTGREST_LIST)
        .select("*");
      if (error) return json({ success: false, error: error.message }, 500);
      if (!rows?.length) {
        return json({ success: false, error: "Trip no longer eligible for Make Available" }, 409);
      }
      await audit(gate.supabase, {
        adminUserId,
        action,
        tripId,
        reason,
        previous,
        resulting: snapshot(rows[0]),
      });
      void notifyScheduledMarketplaceOpen(gate.supabase, rows[0]);
      return json({ success: true, action, trip_id: tripId });
    }

    if (action === "make_available_at" || action === "broadcast_at" || action === "assign_at") {
      const atIso = String(body.execute_at ?? body.executeAt ?? "").trim();
      const atMs = Date.parse(atIso);
      if (!Number.isFinite(atMs) || atMs <= Date.now()) {
        return json({ success: false, error: "execute_at must be in the future" }, 400);
      }
      const kind = action === "make_available_at"
        ? "jobs"
        : action === "broadcast_at"
        ? "broadcast"
        : "assign";
      const driverId = kind === "assign" ? String(body.driver_id ?? "").trim() : null;
      if (kind === "assign" && !driverId) {
        return json({ success: false, error: "driver_id required for assign_at" }, 400);
      }
      const { data: rows, error } = await gate.supabase
        .from("trips")
        .update({
          ...buildPendingReleasePatch({
            kind,
            executeAtIso: new Date(atMs).toISOString(),
            driverId,
          }),
          updated_at: nowIso,
        })
        .eq("id", tripId)
        .is("driver_id", null)
        .is("completed_at", null)
        .not("status", "in", TERMINAL_TRIP_STATUS_POSTGREST_LIST)
        .select("*");
      if (error) return json({ success: false, error: error.message }, 500);
      if (!rows?.length) {
        return json({ success: false, error: "Trip no longer eligible for pending release" }, 409);
      }
      await audit(gate.supabase, {
        adminUserId,
        action,
        tripId,
        reason,
        previous,
        resulting: snapshot(rows[0]),
      });
      return json({ success: true, action, trip_id: tripId });
    }

    if (action === "broadcast_now") {
      const { data: globalCfg } = await gate.supabase
        .from("global_dispatch_settings")
        .select("max_driver_find_time_minutes, max_dispatch_rounds")
        .eq("singleton", true)
        .maybeSingle();
      const cfg = resolveScheduledDispatchConfig(globalCfg ?? {});
      const searchingExpiresAtIso = new Date(
        now.getTime() + cfg.maxFindDriverMinutes * 60_000,
      ).toISOString();
      const { data: priorOffers } = await gate.supabase
        .from("ride_offers")
        .select("broadcast_round")
        .eq("trip_id", tripId)
        .order("broadcast_round", { ascending: false })
        .limit(1);
      const maxExisting = Number(priorOffers?.[0]?.broadcast_round ?? 0);
      const patch = buildBroadcastNowPatch({
        nowIso,
        searchingExpiresAtIso,
        maxExistingBroadcastRound: Number.isFinite(maxExisting) ? maxExisting : 0,
        maxBroadcastSequences: maxBroadcastSequences(
          { max_dispatch_rounds: globalCfg?.max_dispatch_rounds },
          null,
        ),
        currentBroadcastEnabled: trip.broadcast_enabled,
      });
      if (patch.broadcast_enabled === false) {
        return json({
          success: false,
          error: "AIRPORT_PRICING_UNRESOLVED",
          message: "Broadcast Now blocked by airport pricing hold.",
        }, 409);
      }
      const { data: rows, error } = await gate.supabase
        .from("trips")
        .update({ ...patch, scheduled_hold_reason: null })
        .eq("id", tripId)
        .is("driver_id", null)
        .is("completed_at", null)
        .in("scheduled_status", ["admin_held", "scheduled", "pending", "driver_assigned"])
        .not("status", "in", TERMINAL_TRIP_STATUS_POSTGREST_LIST)
        .select("*");
      if (error) return json({ success: false, error: error.message }, 500);
      if (!rows?.length) {
        return json({ success: false, error: "Trip no longer eligible for Broadcast Now" }, 409);
      }
      await audit(gate.supabase, {
        adminUserId,
        action,
        tripId,
        reason,
        previous,
        resulting: snapshot(rows[0]),
      });
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      try {
        await fetch(`${supabaseUrl}/functions/v1/auto-dispatch`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${serviceKey}`,
          },
          body: JSON.stringify({
            trip_id: tripId,
            force_rebroadcast: true,
            trigger_reason: "admin_broadcast_now",
          }),
        });
      } catch (e) {
        console.warn("[admin-scheduled-ride-action] auto-dispatch kick failed", e);
      }
      return json({ success: true, action, trip_id: tripId });
    }

    return json({ success: false, error: "unhandled action" }, 400);
  } catch (e) {
    console.error("[admin-scheduled-ride-action]", e);
    return json({ success: false, error: String((e as Error)?.message ?? e) }, 500);
  }
});
