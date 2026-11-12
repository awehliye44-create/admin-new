/**
 * Phase 3 — Admin emergency scheduled-ride actions (backend-gated).
 * Page + action RBAC here; state mutation + audit_logs via
 * admin_scheduled_emergency_mutate (single DB transaction).
 */
import {
  corsHeaders,
  requireAdminOrStaff,
  requireAnyPageAccess,
} from "../_shared/adminPaymentGate.ts";
import { requireStaffAction } from "../_shared/staffActionAuth.ts";
import { permissionKeyForScheduledRideAction } from "../_shared/scheduledRidesActionPermissionsSSOT.ts";
import { assertPaymentGate, PaymentGateError } from "../_shared/paymentGate.ts";
import { buildBroadcastNowPatch } from "../_shared/scheduledAdminReleaseSSOT.ts";
import { assertAirportPricingReady } from "../_shared/scheduledMarketplaceHoldSSOT.ts";
import { notifyScheduledMarketplaceOpen } from "../_shared/scheduledMarketplaceNotifySSOT.ts";
import { resolveScheduledDispatchConfig } from "../_shared/scheduledDispatchConfig.ts";
import { maxBroadcastSequences } from "../_shared/dispatch-settings.ts";
import { disposeTerminalTripPayment } from "../_shared/terminalTripPaymentDisposition.ts";
import { notifyCustomerTripLifecycle } from "../_shared/customerTripLifecycleNotify.ts";
import { driverMayTakeAdditionalScheduledBooking } from "../_shared/scheduledCommitmentOfferGateSSOT.ts";
import {
  checkScheduledCommissionWalletGate,
  SCHEDULED_COMMISSION_WALLET_ERROR,
} from "../_shared/scheduledMarketplaceCommissionWalletGate.ts";

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

/** Retired staff controls — automation owns publication + fallback dispatch. */
const RETIRED_MANUAL_SCHEDULED_CONTROLS = new Set([
  "make_available_now",
  "make_available_at",
  "broadcast_now",
  "broadcast_at",
  "hold_exceptional",
]);

type EmergencyMutateResult = {
  success?: boolean;
  error?: string;
  message?: string;
  action?: string;
  trip_id?: string;
  previous?: Record<string, unknown>;
  resulting?: Record<string, unknown>;
  confirmed_driver_id?: string | null;
  result?: unknown;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const adminGate = await requireAdminOrStaff(req);
  if (!adminGate.ok) return adminGate.response;
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
    if (RETIRED_MANUAL_SCHEDULED_CONTROLS.has(action)) {
      return json({
        success: false,
        error: "RETIRED_MANUAL_SCHEDULED_CONTROL",
        message:
          "Manual Broadcast / Make Available / Hold are retired. "
          + "Scheduled Jobs publication and fallback dispatch are automatic. "
          + "Use Assign Driver only for exceptional intervention.",
      }, 410);
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

    const now = new Date();
    const nowIso = now.toISOString();
    const adminUserId = String(gate.userId ?? "");
    let patch: Record<string, unknown> = {};
    const meta: Record<string, unknown> = {};

    // Pre-RPC gates (read-only). Mutation+audit happen only inside the RPC txn.
    if (action === "assign_now") {
      const driverId = String(body.driver_id ?? body.driverId ?? "").trim();
      if (!driverId) return json({ success: false, error: "driver_id required for assign_now" }, 400);
      meta.driver_id = driverId;
      const airport = assertAirportPricingReady({
        broadcastEnabled: trip.broadcast_enabled,
        airportChargePence: trip.airport_charge_pence,
        scheduledHoldReason: trip.scheduled_hold_reason,
      });
      if (!airport.ok) {
        return json({
          success: false,
          error: "AIRPORT_PRICING_UNRESOLVED",
          message:
            "Cannot assign while existing mandatory airport charge failed to persist (Custom Zones route pricing).",
        }, 409);
      }
      // Gap C: Admin assign obeys the same commission-wallet gate as instant / marketplace accept.
      {
        const walletGate = await checkScheduledCommissionWalletGate(gate.supabase, driverId, tripId);
        if (!walletGate.ok) {
          if (walletGate.reason === "wallet_gate_error") {
            return json({
              success: false,
              error: "COMMISSION_WALLET_GATE_CHECK_FAILED",
              message: walletGate.detail ?? "Could not verify commission wallet eligibility",
            }, 500);
          }
          return json({
            success: false,
            error: SCHEDULED_COMMISSION_WALLET_ERROR,
            message: "Driver has insufficient commission wallet balance for this trip",
          }, 409);
        }
      }
      // Phase 4: Admin assign must not create an infeasible multi-commitment.
      {
        const candAt = Date.parse(String(trip.scheduled_at ?? ""));
        if (Number.isFinite(candAt)) {
          const gateCommit = await driverMayTakeAdditionalScheduledBooking({
            supabase: gate.supabase,
            driverId,
            nowMs: Date.now(),
            candidateTripId: tripId,
            candidateScheduledAtMs: candAt,
            candidateDurationMinutes: Number(trip.estimated_duration_minutes) || 30,
            candidatePickupLat: trip.pickup_latitude == null
              ? null
              : Number(trip.pickup_latitude),
            candidatePickupLng: trip.pickup_longitude == null
              ? null
              : Number(trip.pickup_longitude),
            candidateDropoffLat: trip.dropoff_latitude == null
              ? null
              : Number(trip.dropoff_latitude),
            candidateDropoffLng: trip.dropoff_longitude == null
              ? null
              : Number(trip.dropoff_longitude),
          });
          if (!gateCommit.allowed) {
            return json({
              success: false,
              error: "SCHEDULED_COMMITMENT_INFEASIBLE",
              message:
                "This driver already has a confirmed scheduled booking that makes this assignment infeasible.",
              conflict_trip_id: gateCommit.commitmentTripId,
            }, 409);
          }
        }
      }
    }

    if (
      action === "make_available_now" ||
      action === "make_available_at" ||
      action === "broadcast_now" ||
      action === "broadcast_at" ||
      action === "assign_at"
    ) {
      const airport = assertAirportPricingReady({
        broadcastEnabled: trip.broadcast_enabled,
        airportChargePence: trip.airport_charge_pence,
        scheduledHoldReason: trip.scheduled_hold_reason,
      });
      if (!airport.ok) {
        return json({
          success: false,
          error: "AIRPORT_PRICING_UNRESOLVED",
          message:
            "Cannot publish or broadcast while existing mandatory airport charge failed to persist (Custom Zones route pricing).",
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
    }

    if (action === "make_available_at" || action === "broadcast_at" || action === "assign_at") {
      const atIso = String(body.execute_at ?? body.executeAt ?? "").trim();
      const atMs = Date.parse(atIso);
      if (!Number.isFinite(atMs) || atMs <= Date.now()) {
        return json({ success: false, error: "execute_at must be in the future" }, 400);
      }
      meta.execute_at = new Date(atMs).toISOString();
      if (action === "assign_at") {
        const driverId = String(body.driver_id ?? "").trim();
        if (!driverId) return json({ success: false, error: "driver_id required for assign_at" }, 400);
        meta.driver_id = driverId;
      }
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
      patch = buildBroadcastNowPatch({
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
    }

    const { data: mutateRaw, error: mutateErr } = await gate.supabase.rpc(
      "admin_scheduled_emergency_mutate",
      {
        p_action: action,
        p_trip_id: tripId,
        p_actor_user_id: adminUserId,
        p_reason: reason,
        p_patch: patch,
        p_meta: meta,
      },
    );

    if (mutateErr) {
      // Postgres raised (including audit_logs failure) → transaction aborted; trip unchanged.
      const msg = mutateErr.message || "emergency_mutate_failed";
      if (/AUDIT|audit_logs/i.test(msg)) {
        return json({ success: false, error: "AUDIT_REQUIRED", message: msg }, 500);
      }
      return json({ success: false, error: msg }, 500);
    }

    const result = (mutateRaw ?? {}) as EmergencyMutateResult;
    if (result.success !== true) {
      const status = result.error === "PAYMENT_GATE_NOT_SATISFIED" ||
          result.error === "AIRPORT_PRICING_UNRESOLVED" ||
          result.error === "TRIP_NO_LONGER_ELIGIBLE" ||
          result.error === "CAS_MISMATCH" ||
          result.error === "TRIP_ALREADY_COMPLETED" ||
          result.error === "ACTION_PERMISSION_DENIED" ||
          result.error === "SCHEDULED_COMMITMENT_INFEASIBLE" ||
          result.error === "INSUFFICIENT_COMMISSION_WALLET_BALANCE"
        ? 409
        : 400;
      return json({
        success: false,
        error: result.error || "action_failed",
        message: result.message,
        result: result.result,
      }, status);
    }

    // Post-commit side effects only (never part of the mutate+audit transaction).
    if (action === "make_available_now") {
      const { data: published } = await gate.supabase
        .from("trips")
        .select(
          "id, service_area_id, pickup_address, scheduled_at, trip_code, trip_number, scheduled_status, scheduled_broadcast_at, confirmed_driver_id, driver_id, dispatch_mode, status",
        )
        .eq("id", tripId)
        .maybeSingle();
      if (published) void notifyScheduledMarketplaceOpen(gate.supabase, published);
    }

    if (action === "assign_now") {
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
    }

    if (action === "broadcast_now") {
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
    }

    if (action === "cancel_ride") {
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
    }

    return json({
      success: true,
      action,
      trip_id: tripId,
      confirmed_driver_id: result.confirmed_driver_id ?? null,
      previous: result.previous ?? null,
      resulting: result.resulting ?? null,
    });
  } catch (e) {
    console.error("[admin-scheduled-ride-action]", e);
    return json({ success: false, error: String((e as Error)?.message ?? e) }, 500);
  }
});
