/**
 * Phase 3 — Admin emergency scheduled-ride actions (backend-gated).
 * Page access alone is insufficient — each action requires staff_has_action.
 * Make Available / Assign / Broadcast / Hold / Cancel — never client-mutate marketplace fields.
 */
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  corsHeaders,
  requireAdminOrStaff,
  requireAnyPageAccess,
} from "../_shared/adminPaymentGate.ts";
import { requireStaffAction } from "../_shared/staffActionAuth.ts";
import { permissionKeyForScheduledRideAction } from "../_shared/scheduledRidesActionPermissionsSSOT.ts";
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
import { disposeTerminalTripPayment } from "../_shared/terminalTripPaymentDisposition.ts";
import { notifyCustomerTripLifecycle } from "../_shared/customerTripLifecycleNotify.ts";

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
  "assign_now",
  "cancel_pending_release",
  "hold_exceptional",
  "cancel_ride",
]);

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

/**
 * Atomic audit: mutation success is not returned unless audit insert succeeds.
 * On audit failure, compensate by restoring previous marketplace snapshot when provided.
 */
async function auditOrFail(
  supabase: ReturnType<typeof createClient>,
  input: {
    adminUserId: string;
    action: string;
    tripId: string;
    reason: string;
    previous: Record<string, unknown>;
    resulting: Record<string, unknown>;
    compensate?: Record<string, unknown> | null;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabase.from("audit_logs").insert({
    event_type: `ADMIN_SCHEDULED_${input.action.toUpperCase()}`,
    user_id: input.adminUserId,
    trip_id: input.tripId,
    details: {
      reason: input.reason,
      previous: input.previous,
      resulting: input.resulting,
      at: new Date().toISOString(),
      source: "admin-scheduled-ride-action",
    },
  });
  if (!error) return { ok: true };

  if (input.compensate) {
    try {
      await supabase
        .from("trips")
        .update({ ...input.compensate, updated_at: new Date().toISOString() })
        .eq("id", input.tripId);
    } catch (compErr) {
      console.error("[admin-scheduled-ride-action] audit compensate failed", compErr);
    }
  }
  return { ok: false, error: error.message || "audit_insert_failed" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Active staff profile required (inactive / suspended / unauthenticated denied).
  const adminGate = await requireAdminOrStaff(req);
  if (!adminGate.ok) return adminGate.response;
  // Never accept bare service-role for emergency mutations — staff JWT + action only.
  if (adminGate.userId === "service-role") {
    return json({
      success: false,
      error: "Forbidden — staff JWT required",
      code: "STAFF_JWT_REQUIRED",
    }, 403);
  }
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

    const actionKey = permissionKeyForScheduledRideAction(action);
    if (!actionKey) {
      return json({ success: false, error: `No permission mapping for ${action}` }, 400);
    }
    const actionGate = await requireStaffAction(gate, actionKey);
    if (!actionGate.ok) return actionGate.response;

    const { data: trip, error: tripErr } = await gate.supabase
      .from("trips")
      .select("*")
      .eq("id", tripId)
      .maybeSingle();
    if (tripErr || !trip) return json({ success: false, error: "Trip not found" }, 404);

    const previous = snapshot(trip);
    const now = new Date();
    const nowIso = now.toISOString();
    const adminUserId = String(gate.userId ?? "");

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
        .select("id, scheduled_status, scheduled_hold_reason, scheduled_broadcast_at, broadcast_enabled, pending_release_kind, pending_release_at, confirmed_driver_id, driver_id, dispatch_mode, status");
      if (error) return json({ success: false, error: error.message }, 500);
      if (!rows?.length) {
        return json({ success: false, error: "Trip no longer eligible for exceptional hold" }, 409);
      }
      const audit = await auditOrFail(gate.supabase, {
        adminUserId,
        action,
        tripId,
        reason,
        previous,
        resulting: snapshot(rows[0]),
        compensate: previous,
      });
      if (!audit.ok) {
        return json({ success: false, error: "AUDIT_REQUIRED", message: audit.error }, 500);
      }
      return json({ success: true, action, trip_id: tripId });
    }

    if (action === "cancel_pending_release") {
      const { data: rows, error } = await gate.supabase
        .from("trips")
        .update({ ...clearPendingReleasePatch(), updated_at: nowIso })
        .eq("id", tripId)
        .select("id, pending_release_kind, pending_release_at, scheduled_status, scheduled_hold_reason, scheduled_broadcast_at, broadcast_enabled, confirmed_driver_id, driver_id, dispatch_mode, status");
      if (error) return json({ success: false, error: error.message }, 500);
      const resulting = snapshot({ ...trip, ...(rows?.[0] ?? {}) });
      const audit = await auditOrFail(gate.supabase, {
        adminUserId,
        action,
        tripId,
        reason,
        previous,
        resulting,
        compensate: {
          pending_release_kind: previous.pending_release_kind,
          pending_release_at: previous.pending_release_at,
        },
      });
      if (!audit.ok) {
        return json({ success: false, error: "AUDIT_REQUIRED", message: audit.error }, 500);
      }
      return json({ success: true, action, trip_id: tripId });
    }

    if (action === "cancel_ride") {
      if (trip.status === "completed" || trip.completed_at) {
        return json({ success: false, error: "TRIP_ALREADY_COMPLETED" }, 409);
      }

      const { data: cancelResult, error: cancelErr } = await gate.supabase.rpc(
        "apply_terminal_trip_cancellation",
        {
          p_trip_id: tripId,
          p_cancelled_by: "admin",
          p_reason: reason,
        },
      );
      if (cancelErr) {
        const locked = /TERMINAL_STATE_LOCKED/.test(cancelErr.message ?? "");
        return locked
          ? json({ success: false, error: "COMPLETED_TRIP_NOT_CANCELLABLE" }, 409)
          : json({ success: false, error: cancelErr.message }, 500);
      }
      if (
        cancelResult &&
        typeof cancelResult === "object" &&
        (cancelResult as { success?: boolean }).success === false
      ) {
        return json({
          success: false,
          error: (cancelResult as { error?: string }).error || "CANCEL_FAILED",
        }, 409);
      }

      // Scheduled board consistency (service-role; not via admin_page_mutate).
      await gate.supabase
        .from("trips")
        .update({
          scheduled_status: "cancelled",
          confirmed_driver_id: null,
          ...clearPendingReleasePatch(),
          updated_at: nowIso,
        })
        .eq("id", tripId);

      const resulting = snapshot({
        ...trip,
        status: "cancelled",
        scheduled_status: "cancelled",
        confirmed_driver_id: null,
        pending_release_kind: null,
        pending_release_at: null,
      });
      const audit = await auditOrFail(gate.supabase, {
        adminUserId,
        action,
        tripId,
        reason,
        previous,
        resulting,
        // Terminal cancel is not safely compensatable — refuse success without audit.
        compensate: null,
      });
      if (!audit.ok) {
        return json({ success: false, error: "AUDIT_REQUIRED", message: audit.error }, 500);
      }

      try {
        await disposeTerminalTripPayment(gate.supabase, {
          tripId,
          reason: "admin_cancel",
          feePence: 0,
          forceFeePenceOverride: true,
        });
      } catch (payErr) {
        console.warn("[admin-scheduled-ride-action] payment dispose non-fatal", payErr);
      }
      try {
        const passengerId =
          typeof trip.passenger_id === "string" ? trip.passenger_id : null;
        if (passengerId) {
          await notifyCustomerTripLifecycle(gate.supabase, {
            passengerId,
            tripId,
            event: "trip_cancelled",
            body: "Your trip has been cancelled by ONECAB.",
          });
        }
      } catch (notifyErr) {
        console.warn("[admin-scheduled-ride-action] cancel notify non-fatal", notifyErr);
      }
      return json({ success: true, action, trip_id: tripId });
    }

    if (action === "assign_now") {
      const driverId = String(body.driver_id ?? body.driverId ?? "").trim();
      if (!driverId) return json({ success: false, error: "driver_id required for assign_now" }, 400);

      const airport = assertAirportPricingReady({
        broadcastEnabled: trip.broadcast_enabled,
        airportChargePence: trip.airport_charge_pence,
      });
      if (!airport.ok) {
        return json({
          success: false,
          error: "AIRPORT_PRICING_UNRESOLVED",
          message: "Cannot assign while mandatory airport pricing is unresolved.",
        }, 409);
      }

      const { data: assignResult, error: assignErr } = await gate.supabase.rpc(
        "admin_assign_scheduled_driver",
        { p_trip_id: tripId, p_driver_id: driverId },
      );
      if (assignErr) return json({ success: false, error: assignErr.message }, 500);
      const assignBody = (assignResult ?? {}) as {
        success?: boolean;
        error?: string;
        message?: string;
        confirmed_driver_id?: string;
      };
      if (assignBody.success !== true) {
        return json({
          success: false,
          error: assignBody.error || "ASSIGN_FAILED",
          message: assignBody.message,
        }, 409);
      }

      const { data: after } = await gate.supabase
        .from("trips")
        .select("*")
        .eq("id", tripId)
        .maybeSingle();
      const resulting = snapshot(after ?? {
        ...trip,
        confirmed_driver_id: driverId,
        scheduled_status: "driver_assigned",
        ...buildAssignNowPatch({ driverId, nowIso }),
      });
      const audit = await auditOrFail(gate.supabase, {
        adminUserId,
        action,
        tripId,
        reason,
        previous,
        resulting,
        compensate: previous,
      });
      if (!audit.ok) {
        return json({ success: false, error: "AUDIT_REQUIRED", message: audit.error }, 500);
      }

      try {
        const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
        const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
        await fetch(`${supabaseUrl}/functions/v1/admin-trip-action`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${serviceKey}`,
          },
          body: JSON.stringify({
            action: "notify_driver_assigned",
            trip_id: tripId,
            title: "Driver confirmed",
            body: "Your driver is confirmed for your scheduled ride.",
            notification_id: `driver_assigned-${tripId}-scheduled_admin`,
            path: "/account/rides",
          }),
        });
      } catch (notifyErr) {
        console.warn("[admin-scheduled-ride-action] assign notify non-fatal", notifyErr);
      }
      return json({ success: true, action, trip_id: tripId, confirmed_driver_id: driverId });
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
      const audit = await auditOrFail(gate.supabase, {
        adminUserId,
        action,
        tripId,
        reason,
        previous,
        resulting: snapshot(rows[0]),
        compensate: previous,
      });
      if (!audit.ok) {
        return json({ success: false, error: "AUDIT_REQUIRED", message: audit.error }, 500);
      }
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
      const audit = await auditOrFail(gate.supabase, {
        adminUserId,
        action,
        tripId,
        reason,
        previous,
        resulting: snapshot(rows[0]),
        compensate: {
          pending_release_kind: previous.pending_release_kind,
          pending_release_at: previous.pending_release_at,
          pending_release_driver_id: trip.pending_release_driver_id ?? null,
        },
      });
      if (!audit.ok) {
        return json({ success: false, error: "AUDIT_REQUIRED", message: audit.error }, 500);
      }
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
      const audit = await auditOrFail(gate.supabase, {
        adminUserId,
        action,
        tripId,
        reason,
        previous,
        resulting: snapshot(rows[0]),
        compensate: previous,
      });
      if (!audit.ok) {
        return json({ success: false, error: "AUDIT_REQUIRED", message: audit.error }, 500);
      }
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
