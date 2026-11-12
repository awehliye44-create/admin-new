/**
 * Immediate exclusive-activation rescue → same-trip nearby auto-dispatch.
 * Idempotent: CAS on awaiting_activation_accept / driver_assigned / scheduled_committed.
 */

import type { AnySupabaseClient } from "./supabaseClientTypes.ts";
import {
  buildExclusiveFailureConversionPatch,
  EXCLUSIVE_RESCUE_SCHEDULED_STATUSES,
  SCHEDULED_ACTIVATION_EXCLUSIVE_REASON,
  isExclusiveActivationArmedStatus,
} from "./scheduledActivationExclusiveSSOT.ts";
import { maxBroadcastSequences } from "./dispatch-settings.ts";
import { notifyCustomerNegotiationRematch } from "./negotiationFailureRematch.ts";
import {
  isTripTerminalForDispatch,
  TERMINAL_TRIP_STATUS_POSTGREST_LIST,
} from "./tripTerminalDispatch.ts";

export type ExclusiveRescueResult =
  | { ok: true; rescued: true; tripId: string; reason: string }
  | { ok: true; rescued: false; tripId: string; detail: string }
  | { ok: false; tripId: string; error: string };

async function triggerAutoDispatchOnce(args: {
  supabaseUrl: string;
  supabaseServiceKey: string;
  tripId: string;
  triggerReason: string;
  declinedDriverId?: string | null;
}): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    const body: Record<string, unknown> = {
      trip_id: args.tripId,
      force_rebroadcast: true,
      trigger_reason: args.triggerReason,
    };
    if (args.declinedDriverId) {
      body.declined_driver_id = args.declinedDriverId;
    }
    const resp = await fetch(`${args.supabaseUrl}/functions/v1/auto-dispatch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${args.supabaseServiceKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      console.error(
        "[scheduledActivationExclusiveRescue] auto-dispatch failed:",
        resp.status,
        data,
      );
      return {
        ok: false,
        status: resp.status,
        error: typeof data === "object" ? JSON.stringify(data) : String(data),
      };
    }
    return { ok: true, status: resp.status };
  } catch (err) {
    console.error("[scheduledActivationExclusiveRescue] auto-dispatch exception:", err);
    return { ok: false, error: String(err) };
  }
}

/** One immediate retry when DB convert succeeded but Edge invoke failed. */
async function triggerAutoDispatchWithRetry(args: {
  supabaseUrl: string;
  supabaseServiceKey: string;
  tripId: string;
  triggerReason: string;
  declinedDriverId?: string | null;
}): Promise<{ ok: boolean; attempts: number }> {
  const first = await triggerAutoDispatchOnce(args);
  if (first.ok) return { ok: true, attempts: 1 };
  console.warn("SCHEDULED_ACTIVATION_DISPATCH_RETRY", {
    trip_id: args.tripId,
    reason: args.triggerReason,
    first_error: first.error ?? first.status,
  });
  await new Promise((r) => setTimeout(r, 750));
  const second = await triggerAutoDispatchOnce({
    ...args,
    triggerReason: `${args.triggerReason}:retry`,
  });
  return { ok: second.ok, attempts: 2 };
}

/**
 * Release exclusive assignment, exclude the unsuccessful driver, convert to
 * instant nearby search, and kick auto-dispatch immediately.
 */
export async function rescueExclusiveActivationToNearby(
  supabase: AnySupabaseClient,
  args: {
    tripId: string;
    reason: string;
    now?: Date;
    maxFindDriverMinutes: number;
    supabaseUrl: string;
    supabaseServiceKey: string;
    /** Driver who declined / timed out / was ineligible — hard-excluded from fallback. */
    excludeDriverId?: string | null;
    /** Expire any leftover pending/offered exclusive offers first. */
    expireOpenOffers?: boolean;
  },
): Promise<ExclusiveRescueResult> {
  const now = args.now ?? new Date();
  const nowIso = now.toISOString();
  const tripId = String(args.tripId ?? "").trim();
  if (!tripId) {
    return { ok: false, tripId: "", error: "trip_id_required" };
  }

  const { data: trip, error: tripErr } = await supabase
    .from("trips")
    .select(
      "id, status, scheduled_status, dispatch_mode, confirmed_driver_id, driver_id, scheduled_broadcast_at, excluded_driver_ids, passenger_id, completed_at, broadcast_enabled",
    )
    .eq("id", tripId)
    .maybeSingle();

  if (tripErr || !trip) {
    return { ok: false, tripId, error: tripErr?.message ?? "trip_not_found" };
  }

  if (isTripTerminalForDispatch(trip)) {
    return { ok: true, rescued: false, tripId, detail: "terminal" };
  }

  const sched = String(trip.scheduled_status ?? "").trim().toLowerCase();
  if (sched === "converted_to_instant") {
    return { ok: true, rescued: false, tripId, detail: "already_converted" };
  }
  if (
    sched !== "awaiting_activation_accept" &&
    sched !== "driver_assigned" &&
    sched !== "scheduled_committed"
  ) {
    return { ok: true, rescued: false, tripId, detail: `status_${sched || "empty"}` };
  }

  const excludeDriverId =
    String(args.excludeDriverId ?? trip.confirmed_driver_id ?? "").trim() || null;

  if (args.expireOpenOffers !== false) {
    await supabase
      .from("ride_offers")
      .update({ status: "expired", updated_at: nowIso })
      .eq("trip_id", tripId)
      .in("status", ["pending", "offered"]);
  }

  const maxFind = Math.max(1, Number(args.maxFindDriverMinutes ?? 6));
  const searchingExpiresAtIso = new Date(now.getTime() + maxFind * 60_000).toISOString();
  const { data: priorOffers } = await supabase
    .from("ride_offers")
    .select("broadcast_round")
    .eq("trip_id", tripId)
    .order("broadcast_round", { ascending: false })
    .limit(1);
  const maxExistingBroadcastRound = Number(priorOffers?.[0]?.broadcast_round ?? 0);
  const { data: globalRounds } = await supabase
    .from("global_dispatch_settings")
    .select("max_dispatch_rounds")
    .eq("singleton", true)
    .maybeSingle();
  const instantMaxSequences = maxBroadcastSequences(
    { max_dispatch_rounds: globalRounds?.max_dispatch_rounds },
    null,
  );
  const patch = buildExclusiveFailureConversionPatch({
    nowIso,
    searchingExpiresAtIso,
    scheduledBroadcastAt: trip.scheduled_broadcast_at ?? nowIso,
    excludeDriverId,
    existingExcludedDriverIds: trip.excluded_driver_ids,
    maxExistingBroadcastRound: Number.isFinite(maxExistingBroadcastRound)
      ? maxExistingBroadcastRound
      : 0,
    maxBroadcastSequences: instantMaxSequences,
    currentBroadcastEnabled: (trip as { broadcast_enabled?: boolean | null })
      .broadcast_enabled,
  });
  const allowBroadcast = patch.broadcast_enabled !== false;

  const { data: updatedRows, error: updateErr } = await supabase
    .from("trips")
    .update(patch)
    .eq("id", tripId)
    .is("completed_at", null)
    .not("status", "in", TERMINAL_TRIP_STATUS_POSTGREST_LIST)
    .in("scheduled_status", [...EXCLUSIVE_RESCUE_SCHEDULED_STATUSES])
    .select("id");

  if (updateErr) {
    return { ok: false, tripId, error: updateErr.message };
  }
  if (!updatedRows?.length) {
    return { ok: true, rescued: false, tripId, detail: "cas_matched_0" };
  }

  console.log("SCHEDULED_ACTIVATION_EXCLUSIVE_RESCUE", {
    trip_id: tripId,
    reason: args.reason,
    excluded_driver_id: excludeDriverId,
    broadcast_enabled: allowBroadcast,
  });

  if (!allowBroadcast) {
    console.warn("SCHEDULED_ACTIVATION_RESCUE_BROADCAST_HELD", {
      trip_id: tripId,
      reason: args.reason,
    });
    return { ok: true, rescued: true, tripId, reason: `${args.reason}:broadcast_held` };
  }

  // DB convert already committed. Detect Edge failure and retry once.
  // expire-offers (10s) remains the durable recovery if both attempts fail.
  const dispatchKick = await triggerAutoDispatchWithRetry({
    supabaseUrl: args.supabaseUrl,
    supabaseServiceKey: args.supabaseServiceKey,
    tripId,
    triggerReason: args.reason,
    declinedDriverId: excludeDriverId,
  });
  if (!dispatchKick.ok) {
    console.error("SCHEDULED_ACTIVATION_DISPATCH_KICK_FAILED", {
      trip_id: tripId,
      reason: args.reason,
      attempts: dispatchKick.attempts,
    });
  }

  void notifyCustomerNegotiationRematch(supabase as any, tripId).catch((err) => {
    console.warn("[scheduledActivationExclusiveRescue] rematch notify failed:", err);
  });

  return { ok: true, rescued: true, tripId, reason: args.reason };
}

export async function evaluateConfirmedDriverExclusiveEligibility(
  supabase: AnySupabaseClient,
  args: {
    driverId: string;
    tripId: string;
    nowMs?: number;
    /** Finishing an earlier trip is allowed for preconfirmed scheduled activation. */
    allowOnTrip?: boolean;
  },
): Promise<{ eligible: boolean; reason: string; isStacked: boolean }> {
  const { evaluateRideOfferDriverEligibility } = await import("./rideOfferDriverEligibility.ts");
  const nowMs = args.nowMs ?? Date.now();
  const allowOnTrip = args.allowOnTrip !== false;

  const { data: gds } = await supabase
    .from("global_dispatch_settings")
    .select("presence_max_age_seconds")
    .eq("singleton", true)
    .maybeSingle();
  const presenceMaxAgeSeconds = Number(gds?.presence_max_age_seconds);
  if (!Number.isFinite(presenceMaxAgeSeconds) || presenceMaxAgeSeconds <= 0) {
    return { eligible: false, reason: "presence_max_age_missing", isStacked: false };
  }

  const { data: driver } = await supabase
    .from("drivers")
    .select(
      "id, current_lat, current_lng, current_trip_id, is_online, driver_online_intent, approval_status, driver_status, documents_approved, last_gps_sample_at, speed",
    )
    .eq("id", args.driverId)
    .maybeSingle();
  if (!driver) {
    return { eligible: false, reason: "driver_offline", isStacked: false };
  }

  const isStacked = Boolean(driver.current_trip_id);

  const { data: presence } = await supabase
    .from("driver_presence")
    .select(
      "status, lat, lng, last_heartbeat_at, last_gps_sample_at, speed, socket_connected, app_state, push_token",
    )
    .eq("driver_id", args.driverId)
    .maybeSingle();

  const { data: activeDevice } = await supabase
    .from("driver_active_devices")
    .select("device_id")
    .eq("driver_id", args.driverId)
    .maybeSingle();

  let hasActivePushToken = false;
  if (activeDevice?.device_id) {
    const { count } = await supabase
      .from("push_tokens")
      .select("id", { count: "exact", head: true })
      .eq("driver_id", args.driverId)
      .eq("app_type", "driver")
      .eq("is_active", true)
      .eq("device_id", activeDevice.device_id);
    hasActivePushToken = (count ?? 0) > 0;
  }

  const eligibility = evaluateRideOfferDriverEligibility({
    driver,
    presence,
    hasActivePushToken,
    presenceMaxAgeSeconds,
    nowMs,
    allowOnTrip,
    // Exclusive arm: realtime OR push is enough to present; lack of push alone
    // must not block arming when presence is healthy (push fail ≠ decline).
    requireDeliveryChannel: false,
  });

  if (!eligibility.eligible) {
    return { eligible: false, reason: eligibility.reason, isStacked };
  }

  const { data: trip } = await supabase
    .from("trips")
    .select("id, excluded_driver_ids, service_area_id")
    .eq("id", args.tripId)
    .maybeSingle();
  const excluded = Array.isArray(trip?.excluded_driver_ids)
    ? (trip!.excluded_driver_ids as unknown[]).map((x) => String(x))
    : [];
  if (excluded.includes(args.driverId)) {
    return { eligible: false, reason: "driver_excluded", isStacked };
  }

  const { data: walletOk, error: walletErr } = await supabase.rpc(
    "driver_passes_commission_wallet_dispatch_gate",
    { p_driver_id: args.driverId, p_trip_id: args.tripId },
  );
  if (walletErr || walletOk !== true) {
    return { eligible: false, reason: "wallet_ineligible", isStacked };
  }

  const categoryReject = await supabase.rpc("driver_vehicle_category_reject_reason", {
    p_driver_id: args.driverId,
    p_trip_id: args.tripId,
  });
  if (categoryReject.error) {
    console.warn(
      "[scheduledActivationExclusiveRescue] vehicle category RPC failed:",
      categoryReject.error,
    );
  } else if (categoryReject.data) {
    return {
      eligible: false,
      reason: String(categoryReject.data),
      isStacked,
    };
  }

  return { eligible: true, reason: "eligible", isStacked };
}

export {
  SCHEDULED_ACTIVATION_EXCLUSIVE_REASON,
  isExclusiveActivationArmedStatus,
};
