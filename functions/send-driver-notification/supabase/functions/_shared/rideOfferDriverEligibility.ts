/**
 * Shared ride-offer eligibility predicate (SSOT for auto-dispatch + push gate).
 *
 * Hard rules:
 * - Never offer or push to offline / stale-presence drivers.
 * - Never treat backend presence.app_state === 'foreground' as a reason to
 *   skip an OS ride-offer push (callers must not use app_state to suppress).
 * - Delivery miss / ACK timeout is not a decline (handled elsewhere).
 */

import { computeDriverLocationState } from "./driverLocationState.ts";

export type RideOfferEligibilityReason =
  | "eligible"
  | "driver_status_not_active"
  | "not_approved"
  | "documents_not_approved"
  | "driver_offline"
  | "online_intent_false"
  | "already_on_trip"
  | "no_presence_row"
  | "presence_not_online"
  | "stale_heartbeat"
  | "no_location"
  | "location_frozen"
  | "no_delivery_channel"
  | "driver_excluded"
  | "wallet_ineligible";

export interface RideOfferEligibilityDriver {
  id: string;
  driver_status?: string | null;
  approval_status?: string | null;
  documents_approved?: boolean | null;
  is_online?: boolean | null;
  driver_online_intent?: boolean | null;
  current_trip_id?: string | null;
  current_lat?: number | null;
  current_lng?: number | null;
  last_gps_sample_at?: string | null;
  speed?: number | null;
}

export interface RideOfferEligibilityPresence {
  status?: string | null;
  lat?: number | null;
  lng?: number | null;
  last_heartbeat_at?: string | null;
  last_gps_sample_at?: string | null;
  speed?: number | null;
  socket_connected?: boolean | null;
  /** Observability only — NEVER used to suppress OS push. */
  app_state?: string | null;
  push_token?: string | null;
}

export interface RideOfferEligibilityInput {
  driver: RideOfferEligibilityDriver;
  presence: RideOfferEligibilityPresence | null;
  hasActivePushToken: boolean;
  presenceMaxAgeSeconds: number;
  nowMs?: number;
  /** Stacked path may allow drivers with an active trip. */
  allowOnTrip?: boolean;
  /**
   * When true, require registered push OR healthy foreground realtime.
   * Push send path should set this false and require hasActivePushToken separately.
   */
  requireDeliveryChannel?: boolean;
}

export interface RideOfferEligibilityResult {
  eligible: boolean;
  reason: RideOfferEligibilityReason;
  resolvedLat: number | null;
  resolvedLng: number | null;
  heartbeatAgeSeconds: number | null;
  realtimeDeliveryAvailable: boolean;
  canDeliverViaForegroundRealtime: boolean;
  effectiveDeliveryChannel: "realtime" | "push" | "both" | "none";
  /** Echoed for audit only — must not gate push suppression. */
  presenceAppState: string | null;
}

function heartbeatCutoffIso(presenceMaxAgeSeconds: number, nowMs: number): string {
  return new Date(nowMs - presenceMaxAgeSeconds * 1000).toISOString();
}

/**
 * Authoritative online/operational eligibility for creating or pushing a ride offer.
 */
export function evaluateRideOfferDriverEligibility(
  input: RideOfferEligibilityInput,
): RideOfferEligibilityResult {
  const nowMs = input.nowMs ?? Date.now();
  const d = input.driver;
  const presence = input.presence;
  const requireDeliveryChannel = input.requireDeliveryChannel !== false;

  const empty = (
    reason: RideOfferEligibilityReason,
  ): RideOfferEligibilityResult => ({
    eligible: false,
    reason,
    resolvedLat: null,
    resolvedLng: null,
    heartbeatAgeSeconds: null,
    realtimeDeliveryAvailable: false,
    canDeliverViaForegroundRealtime: false,
    effectiveDeliveryChannel: "none",
    presenceAppState: presence?.app_state ?? null,
  });

  if (d.driver_status !== "active") {
    return empty("driver_status_not_active");
  }
  if (d.approval_status !== "approved") {
    return empty("not_approved");
  }
  if (d.documents_approved !== true) {
    return empty("documents_not_approved");
  }
  if (d.is_online !== true) {
    return empty("driver_offline");
  }
  // Authoritative online intent — null/false both fail (matches SQL COALESCE(..., false)).
  if (d.driver_online_intent !== true) {
    return empty("online_intent_false");
  }
  if (!input.allowOnTrip && d.current_trip_id) {
    return empty("already_on_trip");
  }

  if (!presence) {
    return empty("no_presence_row");
  }
  if (presence.status !== "online") {
    return empty("presence_not_online");
  }

  const cutoff = heartbeatCutoffIso(input.presenceMaxAgeSeconds, nowMs);
  const heartbeatStale =
    !presence.last_heartbeat_at ||
    (presence.last_heartbeat_at as string) < cutoff;
  const ageMs = presence.last_heartbeat_at
    ? nowMs - new Date(presence.last_heartbeat_at).getTime()
    : null;

  if (heartbeatStale) {
    return {
      ...empty("stale_heartbeat"),
      heartbeatAgeSeconds: ageMs != null ? Math.round(ageMs / 1000) : null,
      presenceAppState: presence.app_state ?? null,
    };
  }

  const resolvedLat = presence.lat ?? d.current_lat ?? null;
  const resolvedLng = presence.lng ?? d.current_lng ?? null;
  if (resolvedLat == null || resolvedLng == null) {
    return empty("no_location");
  }

  const locationState = computeDriverLocationState({
    driverOnlineIntent: d.driver_online_intent ?? d.is_online,
    lastHeartbeatAt: presence.last_heartbeat_at ?? null,
    lastGpsSampleAt: presence.last_gps_sample_at ?? d.last_gps_sample_at ?? null,
    speed: presence.speed ?? d.speed ?? null,
    now: new Date(nowMs),
  });
  // MK-260904-003: do NOT hard-exclude location_frozen here. Fresh heartbeat +
  // aged GPS is degradable (parity with JS auto-dispatch + trip_insert SQL fix).
  // Coords already required above (no_location). locationState kept for audit.
  void locationState;

  const isForeground = presence.app_state === "foreground";
  const hasHealthyRealtimeSocket =
    presence.status === "online" &&
    !heartbeatStale &&
    presence.socket_connected === true;
  const realtimeDeliveryAvailable = hasHealthyRealtimeSocket;
  // Foreground realtime is a delivery channel for web sessions WITHOUT push.
  // It must NEVER be used to suppress an OS push when a push token exists.
  const canDeliverViaForegroundRealtime = hasHealthyRealtimeSocket && isForeground;
  const hasRegisteredPushToken = input.hasActivePushToken;

  const effectiveDeliveryChannel: RideOfferEligibilityResult["effectiveDeliveryChannel"] =
    hasRegisteredPushToken
      ? (realtimeDeliveryAvailable ? "both" : "push")
      : canDeliverViaForegroundRealtime
      ? "realtime"
      : "none";

  if (
    requireDeliveryChannel &&
    !hasRegisteredPushToken &&
    !canDeliverViaForegroundRealtime
  ) {
    return {
      eligible: false,
      reason: "no_delivery_channel",
      resolvedLat,
      resolvedLng,
      heartbeatAgeSeconds: ageMs != null ? Math.round(ageMs / 1000) : null,
      realtimeDeliveryAvailable,
      canDeliverViaForegroundRealtime,
      effectiveDeliveryChannel,
      presenceAppState: presence.app_state ?? null,
    };
  }

  return {
    eligible: true,
    reason: "eligible",
    resolvedLat,
    resolvedLng,
    heartbeatAgeSeconds: ageMs != null ? Math.round(ageMs / 1000) : null,
    realtimeDeliveryAvailable,
    canDeliverViaForegroundRealtime,
    effectiveDeliveryChannel,
    presenceAppState: presence.app_state ?? null,
  };
}

/** Voluntary decline cooldown only — never expired/ack_timeout/delivery miss. */
export function isVoluntaryDeclineCooldownStatus(status: string): boolean {
  return status === "declined";
}

export type RideOfferPushGateSkipReason =
  | RideOfferEligibilityReason
  | "offer_not_found"
  | "offer_not_pending"
  | "offer_expired"
  | "offer_driver_mismatch"
  | "no_active_push_token"
  | "presence_max_age_missing";

export interface RideOfferPushGateOk {
  ok: true;
  eligibility: RideOfferEligibilityResult;
  offer: {
    id: string;
    trip_id: string;
    driver_id: string;
    status: string;
    expires_at: string | null;
    is_stacked?: boolean | null;
  };
}

export interface RideOfferPushGateSkip {
  ok: false;
  reason: RideOfferPushGateSkipReason;
  revoke: boolean;
  offerId?: string;
  tripId?: string;
}

export type RideOfferPushGateResult = RideOfferPushGateOk | RideOfferPushGateSkip;

type SupabaseLike = {
  from: (table: string) => any;
  rpc: (fn: string, args?: Record<string, unknown>) => any;
};

/**
 * Revalidate the committed offer's driver immediately before each push attempt.
 * Never uses presence.app_state to skip sending.
 */
export async function evaluateRideOfferPushGate(
  supabase: SupabaseLike,
  args: {
    driverId: string;
    offerId: string | null | undefined;
    nowMs?: number;
  },
): Promise<RideOfferPushGateResult> {
  const nowMs = args.nowMs ?? Date.now();
  const offerId = args.offerId?.trim() || null;

  if (!offerId) {
    return { ok: false, reason: "offer_not_found", revoke: false };
  }

  const { data: offer, error: offerErr } = await supabase
    .from("ride_offers")
    .select("id, trip_id, driver_id, status, expires_at, is_stacked")
    .eq("id", offerId)
    .maybeSingle();

  if (offerErr || !offer) {
    return { ok: false, reason: "offer_not_found", revoke: false, offerId };
  }

  if (offer.driver_id !== args.driverId) {
    return {
      ok: false,
      reason: "offer_driver_mismatch",
      revoke: false,
      offerId: offer.id,
      tripId: offer.trip_id,
    };
  }

  if (offer.status !== "pending") {
    return {
      ok: false,
      reason: "offer_not_pending",
      revoke: false,
      offerId: offer.id,
      tripId: offer.trip_id,
    };
  }

  if (offer.expires_at && new Date(offer.expires_at).getTime() <= nowMs) {
    return {
      ok: false,
      reason: "offer_expired",
      revoke: false,
      offerId: offer.id,
      tripId: offer.trip_id,
    };
  }

  const { data: gds } = await supabase
    .from("global_dispatch_settings")
    .select("presence_max_age_seconds")
    .eq("singleton", true)
    .maybeSingle();

  const presenceMaxAgeSeconds = Number(gds?.presence_max_age_seconds);
  if (!Number.isFinite(presenceMaxAgeSeconds) || presenceMaxAgeSeconds <= 0) {
    return {
      ok: false,
      reason: "presence_max_age_missing",
      revoke: true,
      offerId: offer.id,
      tripId: offer.trip_id,
    };
  }

  const { data: driver } = await supabase
    .from("drivers")
    .select(
      "id, current_lat, current_lng, current_trip_id, is_online, driver_online_intent, approval_status, driver_status, documents_approved, last_gps_sample_at, speed",
    )
    .eq("id", args.driverId)
    .maybeSingle();

  if (!driver) {
    return {
      ok: false,
      reason: "driver_offline",
      revoke: true,
      offerId: offer.id,
      tripId: offer.trip_id,
    };
  }

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
    const { count: activeTokenCount } = await supabase
      .from("push_tokens")
      .select("id", { count: "exact", head: true })
      .eq("driver_id", args.driverId)
      .eq("app_type", "driver")
      .eq("is_active", true)
      .eq("device_id", activeDevice.device_id);
    hasActivePushToken = (activeTokenCount ?? 0) > 0;
  }

  if (!hasActivePushToken) {
    return {
      ok: false,
      reason: "no_active_push_token",
      revoke: true,
      offerId: offer.id,
      tripId: offer.trip_id,
    };
  }

  const eligibility = evaluateRideOfferDriverEligibility({
    driver,
    presence,
    hasActivePushToken: true,
    presenceMaxAgeSeconds,
    nowMs,
    allowOnTrip: !!offer.is_stacked,
    // Push path: delivery channel already satisfied by active token.
    requireDeliveryChannel: false,
  });

  if (!eligibility.eligible) {
    return {
      ok: false,
      reason: eligibility.reason,
      revoke: true,
      offerId: offer.id,
      tripId: offer.trip_id,
    };
  }

  // Trip exclusion + wallet (trip-scoped) — same gates as SQL dispatch twin.
  const { data: trip } = await supabase
    .from("trips")
    .select("id, excluded_driver_ids, service_area_id")
    .eq("id", offer.trip_id)
    .maybeSingle();

  const excluded = Array.isArray(trip?.excluded_driver_ids)
    ? (trip.excluded_driver_ids as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  if (excluded.includes(args.driverId)) {
    return {
      ok: false,
      reason: "driver_excluded",
      revoke: true,
      offerId: offer.id,
      tripId: offer.trip_id,
    };
  }

  const { data: walletOk, error: walletErr } = await supabase.rpc(
    "driver_passes_commission_wallet_dispatch_gate",
    { p_driver_id: args.driverId, p_trip_id: offer.trip_id },
  );
  if (walletErr) {
    console.warn(
      "[rideOfferDriverEligibility] wallet gate RPC failed — failing closed for push",
      walletErr.message ?? walletErr,
    );
    return {
      ok: false,
      reason: "wallet_ineligible",
      revoke: true,
      offerId: offer.id,
      tripId: offer.trip_id,
    };
  }
  if (walletOk === false) {
    return {
      ok: false,
      reason: "wallet_ineligible",
      revoke: true,
      offerId: offer.id,
      tripId: offer.trip_id,
    };
  }

  return { ok: true, eligibility, offer };
}

/**
 * Revoke a pending offer for a non-driver-fault delivery/eligibility miss.
 * Does NOT set responded_at (never counts as voluntary decline).
 */
export async function revokeRideOfferNonDriverFault(
  supabase: SupabaseLike,
  args: {
    offerId: string;
    reason: string;
    deliveryPhase?: string;
    extraTrace?: Record<string, unknown>;
  },
): Promise<boolean> {
  const now = new Date().toISOString();

  const { data: prior, error: priorErr } = await supabase
    .from("ride_offers")
    .select("id, trip_id, driver_id, delivery_trace, status")
    .eq("id", args.offerId)
    .maybeSingle();

  if (priorErr || !prior || prior.status !== "pending") {
    return false;
  }

  const priorTrace =
    prior.delivery_trace && typeof prior.delivery_trace === "object"
      ? (prior.delivery_trace as Record<string, unknown>)
      : {};

  const { data, error } = await supabase
    .from("ride_offers")
    .update({
      status: "revoked",
      revoked_reason: args.reason.slice(0, 120),
      delivery_phase: args.deliveryPhase ?? "delivery_ineligible",
      // Leave responded_at null — not a voluntary decline / cooldown event.
      delivery_trace: {
        ...priorTrace,
        non_driver_fault: true,
        revoke_reason: args.reason,
        revoked_at: now,
        ...(args.extraTrace ?? {}),
      },
      updated_at: now,
    })
    .eq("id", args.offerId)
    .eq("status", "pending")
    .select("id, trip_id, driver_id")
    .maybeSingle();

  if (error) {
    console.error("[revokeRideOfferNonDriverFault] update failed", error);
    return false;
  }
  if (!data) return false;

  // Clear live trip pointer only when it still names this driver.
  if (data.trip_id && data.driver_id) {
    await supabase
      .from("trips")
      .update({
        current_offer_driver_id: null,
        current_offer_expires_at: null,
        updated_at: now,
      })
      .eq("id", data.trip_id)
      .eq("current_offer_driver_id", data.driver_id);
  }

  return true;
}
