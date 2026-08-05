import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { requireAuthenticatedUser } from "../_shared/edgeAuth.ts";
import { getDriverCommission } from "../_shared/commission.ts";
import { resolveTripFare, type TripFareRow } from "../_shared/tripFareSSOT.ts";
import { calculateTripSettlement, tripSettlementDbColumns } from "../_shared/tripSettlement.ts";
import {
  securityHeaders,
  jsonHeaders,
  checkRateLimit,
  getClientIP,
  rateLimitResponse,
  handleCORSPreflight,
  successResponse,
  errorResponse,
  isValidUUID,
  isValidAction,
  validationErrorResponse,
} from "../_shared/security.ts";
import {
  buildPickupWaitingSnapshot,
  buildStopWaitingSnapshot,
  loadAdminWaitingConfig,
} from "../_shared/waitingAdminConfig.ts";
import {
  logStackedPromotionSkipped,
  handleQueuedTripAfterPaymentFailure,
  tryPromoteStackedTripAfterCompletion,
} from "../_shared/stackedRideLifecycle.ts";
import {
  executeDriverQueuedStackedCancel,
  executeDriverTerminalCancel,
} from "../_shared/driverTripCancel.ts";
import {
  mapStopWorkflowActionToLifecycleAction,
  validateTripActionTransition,
  type TripStopRecord,
} from "../_shared/tripLifecycle.ts";
import {
  evaluateFarFromLocationConfirmation,
  farFromLocationAuditEventType,
  farFromLocationBlockedMessage,
  type FarFromLocationAction,
} from "../_shared/farFromLocationGate.ts";
import {
  logRequestDuration,
  startRequestTimer,
  withDuration,
  createRequestId,
  finishEdgeRequestLog,
} from "../_shared/edgeRequestTiming.ts";
import { invokeFinalizeTripCapture as invokeFinalizeTripCaptureWithRetry } from "../_shared/invokeFinalizeTripCapture.ts";
import {
  CAN_START_JOURNEY_FROM_STATUSES,
  CANONICAL_EN_ROUTE_TO_PICKUP,
  EN_ROUTE_TO_PICKUP_STATUSES,
  resolveStartJourneyToPickupDecision,
} from "../_shared/startJourneyToPickupDecision.ts";

const RATE_LIMIT_CONFIG = {
  limit: 60,
  windowMs: 60000,
  keyPrefix: 'stop-workflow'
};

const nonNegInt = (value: unknown): number => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n);
};

const VALID_ACTIONS = [
  'start_journey_to_pickup',
  'arrive_pickup',
  'start_trip',
  'arrive_stop',
  'next_stop',
  'drive_to_next',
  'complete_trip',
  'driver_cancel',
  'cancel_queued_stacked',
];

/**
 * MULTI-STOP WORKFLOW EDGE FUNCTION
 * 
 * Actions:
 * A) arrive_pickup - Mark pickup (stop_index=0) as ARRIVED, set arrived_at
 * B) start_trip - Set started_at, advance to next stop (index 1+)
 * C) arrive_stop - Mark current stop as ARRIVED (for stops after pickup)
 * D) next_stop - Advance to next stop (skip any SKIPPED)
 * E) complete_trip - End the trip (only when at final stop)
 * 
 * Rules:
 * - current_stop_index can NEVER revert backwards
 * - Stops advance in sequence without jumps
 * - Idempotent operations (safe to retry)
 */

type StopStatus = 'pending' | 'current' | 'completed' | 'skipped';
type TripStatus =
  | 'accepted'
  | 'driver_assigned'
  | 'confirmed'
  | 'arrived'
  | 'arrived_pickup'
  | 'arrived_at_pickup'
  | 'in_progress'
  | 'completed'
  | 'cancelled';

const ARRIVED_AT_PICKUP_STATUSES = new Set([
  'arrived',
  'arrived_pickup',
  'arrived_at_pickup',
  'at_pickup',
  'pickup_waiting',
]);

const CAN_ARRIVE_FROM_STATUSES = new Set([
  'driver_assigned',
  'accepted',
  'confirmed',
  'en_route',
  'en_route_to_pickup',
  'driver_en_route',
  'enroute_to_pickup',
  'driver_arriving',
  'queued',
]);

const CANONICAL_ARRIVED_STATUS: TripStatus = 'arrived_at_pickup';

/** Terminal trips cannot be progressed via stop-workflow. */
const TRIP_TERMINAL_STATUSES = new Set([
  'cancelled',
  'canceled',
  'customer_cancelled',
  'driver_cancelled',
  'completed',
  'no_show',
  'no-show',
  'expired',
  'declined',
]);

/**
 * Columns safe to write when PostgREST reports missing schema (PGRST204).
 * Includes pass-2 multi-stop fields from 20260606120000 so stop waiting /
 * destination mirrors are not silently dropped on retry.
 */
const PROD_SAFE_TRIP_COLUMNS = new Set([
  'started_at',
  'status',
  'current_stop_index',
  'current_stop_id',
  'current_destination_index',
  'current_destination_type',
  'arrived_at',
  'pickup_arrived_at',
  'pickup_waiting_started_at',
  'completed_at',
  'updated_at',
  'total_waiting_charge_pence',
  'waiting_charge_pence',
  'stop_charge_total_pence',
  'paid_waiting_started_at',
  'pickup_waiting_charge_pence',
  'waiting_minutes',
  'stop_arrived_at',
  'stop_waiting_started_at',
  'stop_waiting_free_seconds',
  'stop_waiting_paid_started_at',
  'stop_waiting_finalized_at',
  'stop_waiting_status',
  'stop_waiting_charge_amount',
  'pickup_waiting_admin_config',
]);

function normTripStatus(status: string | null | undefined): string {
  return String(status || '').trim().toLowerCase().replace(/-/g, '_');
}

function isTripTerminalStatus(status: string | null | undefined): boolean {
  const s = normTripStatus(status);
  if (!s) return false;
  if (TRIP_TERMINAL_STATUSES.has(s)) return true;
  return s.includes('cancelled') || s.includes('canceled');
}

function pickProdSafeTripPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (PROD_SAFE_TRIP_COLUMNS.has(key)) out[key] = value;
  }
  if (!('updated_at' in out)) {
    out.updated_at = new Date().toISOString();
  }
  return out;
}

function isSchemaColumnError(err: { message?: string; code?: string } | null): boolean {
  if (!err) return false;
  const msg = String(err.message || '').toLowerCase();
  return err.code === 'PGRST204' || msg.includes('column') || msg.includes('schema cache');
}

/** Set pickup_waiting_started_at when driver is inside radius — never backfill from arrived_at. */
async function ensurePickupWaitingStarted(
  supabase: ReturnType<typeof createClient>,
  tripId: string,
  trip: { arrived_at?: string | null; pickup_waiting_started_at?: string | null },
  pickupStop: { id: string; arrived_at?: string | null; waiting_started_at?: string | null } | null | undefined,
  now: string,
): Promise<string> {
  if (trip.pickup_waiting_started_at) return trip.pickup_waiting_started_at;
  const waitingStartAt = now;
  const tripPayload: Record<string, unknown> = {
    pickup_waiting_started_at: waitingStartAt,
    updated_at: now,
  };
  if (trip.arrived_at) {
    tripPayload.pickup_arrived_at = trip.arrived_at;
  }
  await updateTripSafe(supabase, tripId, tripPayload);
  if (pickupStop?.id && !pickupStop.waiting_started_at) {
    await supabase
      .from('trip_stops')
      .update({
        waiting_started_at: waitingStartAt,
        updated_at: now,
      })
      .eq('id', pickupStop.id);
  }
  console.log('[stop-workflow] PICKUP_WAITING_STARTED', {
    trip_id: tripId,
    pickup_waiting_started_at: waitingStartAt,
  });
  return waitingStartAt;
}

/** Update trips using full payload when migration columns exist; fall back to prod-safe subset. */
async function updateTripSafe(
  supabase: ReturnType<typeof createClient>,
  tripId: string,
  payload: Record<string, unknown>,
): Promise<{ error: { message: string; code?: string } | null }> {
  const full = { ...payload };
  if (!full.updated_at) full.updated_at = new Date().toISOString();

  const { error: fullErr } = await supabase.from('trips').update(full).eq('id', tripId);
  if (!fullErr) return { error: null };

  if (!isSchemaColumnError(fullErr)) {
    return { error: fullErr };
  }

  console.warn('[stop-workflow] trip update retry with prod-safe columns:', fullErr.message);
  const minimal = pickProdSafeTripPayload(full);
  const { error: retryErr } = await supabase.from('trips').update(minimal).eq('id', tripId);
  return { error: retryErr };
}

interface WorkflowRequest {
  trip_id: string;
  driver_id: string;
  action:
    | 'arrive_pickup'
    | 'start_trip'
    | 'arrive_stop'
    | 'next_stop'
    | 'drive_to_next'
    | 'complete_trip'
    | 'driver_cancel'
    | 'cancel_queued_stacked';
  cancel_reason?: string;
  driver_lat?: number;
  driver_lng?: number;
  /** Far-from-location confirmation evidence (see farFromLocationGate.ts) — never trusted alone. */
  location_accuracy_m?: number;
  /** Epoch ms or ISO string GPS fix timestamp — the moment the fix was captured, not send time. */
  location_timestamp?: number | string;
  /** Explicit driver "Yes" on the far-from-location popup for this exact action + target. */
  far_confirm?: boolean;
  /** Client-claimed current stop id — advisory only; server always resolves the real current stop. */
  stop_id?: string;
  /** Advisory only — included in the far-from-location audit event when present. */
  platform?: string;
}

type DispatchWaitingSettings = {
  enable_stop_waiting_charge?: boolean;
  stop_radius_enabled?: boolean;
  stop_radius_meters?: number;
  stop_waiting_charge_interval_seconds?: number;
  stop_waiting_grace_period_seconds?: number;
  stop_waiting_rate_pence_per_minute?: number;
  stop_waiting_max_minutes?: number | null;
  pickup_radius_enabled?: boolean;
  pickup_radius_meters?: number;
  /** Internal: which table supplied stop radius (for observability). */
  _stop_radius_source?: 'dispatch_settings' | 'stop_waiting_settings';
};

type TripStopRow = {
  id: string;
  stop_index?: number;
  type: string;
  status?: string;
  lat?: number | null;
  lng?: number | null;
  arrived_at?: string | null;
  waiting_charge_active?: boolean | null;
  waiting_started_at?: string | null;
  waiting_stopped_at?: string | null;
  waiting_total_amount_pence?: number | null;
};

/** Haversine distance in meters */
function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

type StopRadiusCheckResult =
  | { ok: true }
  | {
    ok: false;
    current_distance_meters: number;
    required_radius_meters: number;
  };

const OUTSIDE_RADIUS_ERROR = 'OUTSIDE_RADIUS';

/** Standard blocked response when driver is outside admin pickup/stop radius. */
function outsideRadiusResponse(
  scope: 'pickup' | 'stop',
  check: Extract<StopRadiusCheckResult, { ok: false }>,
): Response {
  const distanceM =
    check.current_distance_meters >= 0 ? check.current_distance_meters : null;
  const allowedM = check.required_radius_meters;
  const message =
    distanceM != null
      ? scope === 'pickup'
        ? `You must be within ${allowedM}m of the pickup. Currently ${distanceM}m away.`
        : `You must be within ${allowedM}m of the stop. Currently ${distanceM}m away.`
      : scope === 'pickup'
        ? 'Driver location is required to arrive at pickup.'
        : 'Driver location is required to arrive at this stop.';

  return errorResponse(OUTSIDE_RADIUS_ERROR, message, 400, {
    blocked_reason: OUTSIDE_RADIUS_ERROR,
    scope,
    distance_meters: distanceM,
    allowed_radius_meters: allowedM,
    current_distance_meters: distanceM,
    required_radius_meters: allowedM,
  });
}

type ResolvedWaitingRadius = {
  enabled: boolean;
  meters: number | null;
  source: 'dispatch_settings' | 'stop_waiting_settings' | 'missing';
};

function resolveWaitingRadius(
  scope: 'pickup' | 'stop',
  settings: DispatchWaitingSettings,
  tripId?: string,
): ResolvedWaitingRadius {
  const enabled = scope === 'pickup'
    ? settings.pickup_radius_enabled ?? true
    : settings.stop_radius_enabled ?? true;
  const raw = scope === 'pickup'
    ? settings.pickup_radius_meters
    : settings.stop_radius_meters;
  const source = scope === 'stop' && settings._stop_radius_source === 'stop_waiting_settings'
    ? 'stop_waiting_settings'
    : typeof raw === 'number' && raw > 0
      ? 'dispatch_settings'
      : 'missing';
  const meters = typeof raw === 'number' && raw > 0 ? raw : null;

  if (meters != null) {
    console.log('[stop-workflow] WAITING_RADIUS_BACKEND_USED', {
      trip_id: tripId ?? null,
      scope,
      allowed_radius_meters: meters,
      radius_enabled: enabled,
      source,
    });
  } else {
    console.log('[stop-workflow] WAITING_RADIUS_MISSING_CONFIG', {
      trip_id: tripId ?? null,
      scope,
      radius_enabled: enabled,
    });
  }

  return { enabled, meters, source };
}

function enrichWaitingRadiusSuccessFields(
  base: Record<string, unknown>,
  waitingResult: PickupWaitingStartResult | StopWaitingStartResult,
): Record<string, unknown> {
  const arrivalRecorded = true;
  const waitingStatus = waitingResult.waiting_status;
  const distanceMeters = waitingResult.distance_meters ?? null;
  const allowedRadiusMeters = waitingResult.allowed_radius_meters ?? null;
  return {
    ...base,
    arrival_recorded: arrivalRecorded,
    arrivalRecorded,
    waiting_status: waitingStatus,
    waitingStatus,
    distance_meters: distanceMeters,
    distanceMeters,
    allowed_radius_meters: allowedRadiusMeters,
    allowedRadiusMeters,
  };
}

type TripWaitingBillingCtx = {
  service_area_id?: string | null;
  vehicle_type_id?: string | null;
  arrived_at?: string | null;
  pickup_arrived_at?: string | null;
  driver_arrived_at?: string | null;
  stop_arrived_at?: string | null;
  pickup_paid_waiting_started_at?: string | null;
  pickup_waiting_charge_pence?: number | null;
  stop_waiting_paid_started_at?: string | null;
  stop_waiting_charge_pence?: number | null;
  stop_waiting_status?: string | null;
};

function resolveWaitingStatusFromResult(
  waitingResult: PickupWaitingStartResult | StopWaitingStartResult,
): "not_started" | "blocked_outside_radius" | "free_waiting" {
  if (waitingResult.waiting_status === "blocked_outside_radius") return "blocked_outside_radius";
  if (waitingResult.waiting_status === "free_waiting") return "free_waiting";
  return "not_started";
}

function tripWaitingBillingFields(trip: TripWaitingBillingCtx): Record<string, unknown> {
  return {
    pickup_waiting_paid_started_at: trip.pickup_paid_waiting_started_at ?? null,
    pickup_waiting_charge_pence: trip.pickup_waiting_charge_pence ?? 0,
    active_stop_waiting_state: trip.stop_waiting_status ?? null,
    stop_waiting_paid_started_at: trip.stop_waiting_paid_started_at ?? null,
    stop_waiting_charge_pence: trip.stop_waiting_charge_pence ?? 0,
  };
}

async function enrichArrivalWaitingSnapshot(
  supabase: ReturnType<typeof createClient>,
  base: Record<string, unknown>,
  waitingResult: PickupWaitingStartResult | StopWaitingStartResult,
  ctx: {
    scope: "pickup" | "stop";
    trip: TripWaitingBillingCtx;
    trip_id?: string;
    stop?: { arrived_at?: string | null };
  },
): Promise<Record<string, unknown>> {
  const config = await loadAdminWaitingConfig(
    supabase,
    ctx.trip.service_area_id ?? null,
    ctx.trip.vehicle_type_id ?? null,
  );

  if (ctx.scope === "pickup" && ctx.trip_id) {
    const { error: cfgErr } = await updateTripSafe(supabase, ctx.trip_id, {
      pickup_waiting_admin_config: config,
    });
    if (cfgErr) {
      console.warn("[stop-workflow] PICKUP_WAITING_ADMIN_CONFIG_PERSIST_FAILED", {
        trip_id: ctx.trip_id,
        message: cfgErr.message,
      });
    } else {
      console.log("[stop-workflow] PICKUP_WAITING_ADMIN_CONFIG_PERSISTED", {
        trip_id: ctx.trip_id,
        free_pickup_waiting_seconds: config.free_pickup_waiting_seconds,
        no_show_waiting_minutes: config.no_show_waiting_minutes,
      });
    }
  }

  const radiusFields = enrichWaitingRadiusSuccessFields(base, waitingResult);
  const billing = tripWaitingBillingFields(ctx.trip);

  const driverArrivedAt =
    ctx.trip.pickup_arrived_at ??
    ctx.trip.driver_arrived_at ??
    ctx.trip.arrived_at ??
    null;
  const pickupWaitingStatus =
    ctx.scope === "pickup"
      ? resolveWaitingStatusFromResult(waitingResult)
      : driverArrivedAt
        ? "free_waiting"
        : "not_started";
  const pickupSnapshot = buildPickupWaitingSnapshot({
    driverArrivedAt,
    waitingStatus: pickupWaitingStatus,
    config,
  });

  const stopArrivedAt = ctx.trip.stop_arrived_at ?? ctx.stop?.arrived_at ?? null;
  const stopWaitingStatus =
    ctx.scope === "stop"
      ? resolveWaitingStatusFromResult(waitingResult)
      : stopArrivedAt
        ? "free_waiting"
        : "not_started";
  const stopSnapshot = buildStopWaitingSnapshot({
    stopArrivedAt,
    waitingStatus: stopWaitingStatus,
    config,
  });

  return {
    ...radiusFields,
    ...billing,
    driver_arrived_at: pickupSnapshot.driver_arrived_at,
    pickup_arrived_at: pickupSnapshot.driver_arrived_at,
    pickup_waiting_state: pickupSnapshot.pickup_waiting_state,
    pickup_waiting_free_expires_at: pickupSnapshot.pickup_waiting_free_expires_at,
    pickup_waiting_elapsed_seconds: pickupSnapshot.pickup_waiting_elapsed_seconds,
    pickup_waiting_grace_remaining_seconds: pickupSnapshot.pickup_waiting_grace_remaining_seconds,
    no_show_eligible_at: pickupSnapshot.no_show_eligible_at,
    no_show_eligible: pickupSnapshot.no_show_eligible,
    no_show_remaining_seconds: pickupSnapshot.no_show_remaining_seconds,
    stop_arrived_at: stopSnapshot.stop_arrived_at,
    stop_waiting_state: stopSnapshot.stop_waiting_state,
    stop_waiting_free_expires_at: stopSnapshot.stop_waiting_free_expires_at,
    stop_waiting_elapsed_seconds: stopSnapshot.stop_waiting_elapsed_seconds,
    stop_waiting_grace_remaining_seconds: stopSnapshot.stop_waiting_grace_remaining_seconds,
    admin_waiting_config_snapshot: config,
    waiting_snapshot: ctx.scope === "pickup" ? pickupSnapshot : stopSnapshot,
  };
}

/** Admin SSOT: dispatch_settings + stop_waiting_settings (stop radius). */
async function checkStopArrivalRadius(
  supabase: ReturnType<typeof createClient>,
  serviceAreaId: string | null,
  stop: TripStopRow,
  driverLat: number | undefined,
  driverLng: number | undefined,
  tripId?: string,
): Promise<StopRadiusCheckResult> {
  const settings = await fetchDispatchWaitingSettings(supabase, serviceAreaId);
  const radius = resolveWaitingRadius('stop', settings, tripId);
  const radiusEnabled = radius.enabled;
  const radiusMeters = radius.meters;

  if (!radiusEnabled || radiusMeters == null) {
    return { ok: true };
  }

  if (stop.lat == null || stop.lng == null) {
    return { ok: true };
  }

  if (typeof driverLat !== 'number' || typeof driverLng !== 'number') {
    return {
      ok: false,
      current_distance_meters: -1,
      required_radius_meters: radiusMeters,
    };
  }

  const distance = haversineMeters(driverLat, driverLng, stop.lat, stop.lng);
  if (distance > radiusMeters) {
    return {
      ok: false,
      current_distance_meters: Math.round(distance),
      required_radius_meters: radiusMeters,
    };
  }

  return { ok: true };
}

type PickupWaitingStartResult = {
  started: boolean;
  waiting_status: 'not_started' | 'blocked_outside_radius' | 'free_waiting';
  allowed_radius_meters?: number | null;
  distance_meters?: number | null;
};

type StopWaitingStartResult = {
  started: boolean;
  waiting_status: 'not_started' | 'blocked_outside_radius' | 'free_waiting';
  graceSeconds: number;
  allowed_radius_meters?: number | null;
  distance_meters?: number | null;
};

/** Radius gate for waiting start only — arrival is always recorded separately. */
async function tryStartPickupWaiting(
  supabase: ReturnType<typeof createClient>,
  ctx: {
    tripId: string;
    trip: {
      arrived_at?: string | null;
      pickup_waiting_started_at?: string | null;
      service_area_id?: string | null;
    };
    pickupStop: { id: string; arrived_at?: string | null; waiting_started_at?: string | null } | null | undefined;
    pickupLat: number | null;
    pickupLng: number | null;
    driverLat: number | undefined;
    driverLng: number | undefined;
    now: string;
  },
): Promise<PickupWaitingStartResult> {
  const { tripId, trip, pickupStop, pickupLat, pickupLng, driverLat, driverLng, now } = ctx;

  if (trip.pickup_waiting_started_at) {
    return { started: true, waiting_status: 'free_waiting' };
  }

  const settings = await fetchDispatchWaitingSettings(supabase, trip.service_area_id ?? null);
  const radius = resolveWaitingRadius('pickup', settings, tripId);
  const radiusEnabled = radius.enabled;
  const radiusMeters = radius.meters;
  console.log('[stop-workflow] WAITING_RADIUS_ADMIN_CONFIG_LOADED', {
    trip_id: tripId,
    scope: 'pickup',
    service_area_id: trip.service_area_id ?? null,
    pickup_radius_enabled: radiusEnabled,
    pickup_radius_meters: radiusMeters,
    source: radius.source,
  });

  if (!radiusEnabled) {
    console.log('[stop-workflow] WAITING_RADIUS_CHECK_STARTED', {
      trip_id: tripId,
      scope: 'pickup',
      radius_enforced: false,
    });
    const anchor = trip.arrived_at || pickupStop?.arrived_at || now;
    await ensurePickupWaitingStarted(
      supabase,
      tripId,
      { ...trip, arrived_at: anchor },
      pickupStop,
      now,
    );
    console.log('[stop-workflow] WAITING_RADIUS_CHECK_INSIDE', {
      trip_id: tripId,
      scope: 'pickup',
      radius_enforced: false,
    });
    return { started: true, waiting_status: 'free_waiting' };
  }

  console.log('[stop-workflow] WAITING_RADIUS_CHECK_STARTED', {
    trip_id: tripId,
    scope: 'pickup',
    driver_lat: driverLat ?? null,
    driver_lng: driverLng ?? null,
  });

  const check = await checkPickupArrivalRadius(
    supabase,
    trip.service_area_id ?? null,
    pickupLat,
    pickupLng,
    driverLat,
    driverLng,
    tripId,
  );

  if (!check.ok) {
    const distanceM =
      check.current_distance_meters >= 0 ? check.current_distance_meters : null;
    console.log('[stop-workflow] WAITING_RADIUS_CHECK_OUTSIDE', {
      trip_id: tripId,
      scope: 'pickup',
      distance_meters: distanceM,
      allowed_radius_meters: check.required_radius_meters,
    });
    console.log('[stop-workflow] WAITING_BLOCKED_OUTSIDE_RADIUS', {
      trip_id: tripId,
      scope: 'pickup',
    });
    console.log('[stop-workflow] WAITING_NOT_CHARGED_OUTSIDE_RADIUS', {
      trip_id: tripId,
      scope: 'pickup',
    });
    return {
      started: false,
      waiting_status: 'blocked_outside_radius',
      allowed_radius_meters: check.required_radius_meters,
      distance_meters: distanceM,
    };
  }

  console.log('[stop-workflow] WAITING_RADIUS_CHECK_INSIDE', { trip_id: tripId, scope: 'pickup' });
  const anchor = trip.arrived_at || pickupStop?.arrived_at || now;
  await ensurePickupWaitingStarted(
    supabase,
    tripId,
    { ...trip, arrived_at: anchor },
    pickupStop,
    now,
  );
  return { started: true, waiting_status: 'free_waiting' };
}

/** Radius gate for stop waiting start only — arrival is always recorded separately. */
async function tryStartStopWaiting(
  supabase: ReturnType<typeof createClient>,
  trip: { id: string; service_area_id?: string | null },
  stop: TripStopRow,
  driverLat: number | undefined,
  driverLng: number | undefined,
): Promise<StopWaitingStartResult> {
  if (stop.waiting_charge_active && stop.waiting_started_at) {
    return { started: false, waiting_status: 'free_waiting', graceSeconds: 0 };
  }

  const settings = await fetchDispatchWaitingSettings(supabase, trip.service_area_id ?? null);
  const radius = resolveWaitingRadius('stop', settings, trip.id);
  const radiusEnabled = radius.enabled;
  const radiusMeters = radius.meters;
  console.log('[stop-workflow] WAITING_RADIUS_ADMIN_CONFIG_LOADED', {
    trip_id: trip.id,
    scope: 'stop',
    stop_id: stop.id,
    service_area_id: trip.service_area_id ?? null,
    stop_radius_enabled: radiusEnabled,
    stop_radius_meters: radiusMeters,
    source: radius.source,
  });

  if (!radiusEnabled) {
    console.log('[stop-workflow] WAITING_RADIUS_CHECK_STARTED', {
      trip_id: trip.id,
      scope: 'stop',
      stop_id: stop.id,
      radius_enforced: false,
    });
    const waitingStart = await startStopWaitingOnArrive(supabase, trip, stop);
    console.log('[stop-workflow] WAITING_RADIUS_CHECK_INSIDE', {
      trip_id: trip.id,
      scope: 'stop',
      stop_id: stop.id,
      radius_enforced: false,
    });
    return {
      started: waitingStart.started,
      waiting_status: waitingStart.started ? 'free_waiting' : 'not_started',
      graceSeconds: waitingStart.graceSeconds,
    };
  }

  console.log('[stop-workflow] WAITING_RADIUS_CHECK_STARTED', {
    trip_id: trip.id,
    scope: 'stop',
    stop_id: stop.id,
    driver_lat: driverLat ?? null,
    driver_lng: driverLng ?? null,
  });

  const check = await checkStopArrivalRadius(
    supabase,
    trip.service_area_id ?? null,
    stop,
    driverLat,
    driverLng,
    trip.id,
  );

  if (!check.ok) {
    const distanceM =
      check.current_distance_meters >= 0 ? check.current_distance_meters : null;
    console.log('[stop-workflow] WAITING_RADIUS_CHECK_OUTSIDE', {
      trip_id: trip.id,
      scope: 'stop',
      stop_id: stop.id,
      distance_meters: distanceM,
      allowed_radius_meters: check.required_radius_meters,
    });
    console.log('[stop-workflow] WAITING_BLOCKED_OUTSIDE_RADIUS', {
      trip_id: trip.id,
      scope: 'stop',
      stop_id: stop.id,
    });
    console.log('[stop-workflow] WAITING_NOT_CHARGED_OUTSIDE_RADIUS', {
      trip_id: trip.id,
      scope: 'stop',
      stop_id: stop.id,
    });
    return {
      started: false,
      waiting_status: 'blocked_outside_radius',
      graceSeconds: 0,
      allowed_radius_meters: check.required_radius_meters,
      distance_meters: distanceM,
    };
  }

  console.log('[stop-workflow] WAITING_RADIUS_CHECK_INSIDE', {
    trip_id: trip.id,
    scope: 'stop',
    stop_id: stop.id,
  });
  const waitingStart = await startStopWaitingOnArrive(supabase, trip, stop);
  return {
    started: waitingStart.started,
    waiting_status: waitingStart.started ? 'free_waiting' : 'not_started',
    graceSeconds: waitingStart.graceSeconds,
  };
}

/** Admin SSOT: dispatch_settings.pickup_radius_meters (+ pickup_radius_enabled). */
async function checkPickupArrivalRadius(
  supabase: ReturnType<typeof createClient>,
  serviceAreaId: string | null,
  pickupLat: number | null | undefined,
  pickupLng: number | null | undefined,
  driverLat: number | undefined,
  driverLng: number | undefined,
  tripId?: string,
): Promise<StopRadiusCheckResult> {
  const settings = await fetchDispatchWaitingSettings(supabase, serviceAreaId);
  const radius = resolveWaitingRadius('pickup', settings, tripId);
  const radiusEnabled = radius.enabled;
  const radiusMeters = radius.meters;

  if (!radiusEnabled || radiusMeters == null) {
    return { ok: true };
  }

  if (pickupLat == null || pickupLng == null) {
    return { ok: true };
  }

  if (typeof driverLat !== 'number' || typeof driverLng !== 'number') {
    return {
      ok: false,
      current_distance_meters: -1,
      required_radius_meters: radiusMeters,
    };
  }

  const distance = haversineMeters(driverLat, driverLng, pickupLat, pickupLng);
  if (distance > radiusMeters) {
    return {
      ok: false,
      current_distance_meters: Math.round(distance),
      required_radius_meters: radiusMeters,
    };
  }

  return { ok: true };
}

async function writeTripAudit(
  supabase: ReturnType<typeof createClient>,
  row: {
    trip_id: string;
    driver_id: string;
    event_type: string;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await supabase.from('audit_logs').insert({
      trip_id: row.trip_id,
      driver_id: row.driver_id,
      event_type: row.event_type,
      details: row.details ?? {},
      created_at: new Date().toISOString(),
    });
  } catch (e) {
    console.warn('[stop-workflow] audit_logs insert failed:', row.event_type, e);
  }
}

function parseLocationTimestampMs(value: number | string | null | undefined): number | null {
  if (value == null) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

type FarFromLocationGateContext = {
  supabase: ReturnType<typeof createClient>;
  tripId: string;
  driverId: string;
  action: FarFromLocationAction;
  stopId: string | null;
  targetLat: number | null | undefined;
  targetLng: number | null | undefined;
  driverLat: number | undefined;
  driverLng: number | undefined;
  locationAccuracyM: number | undefined;
  locationTimestampMs: number | null;
  farConfirm: boolean | undefined;
  claimedStopId: string | undefined;
  serviceAreaId: string | null | undefined;
  platform: string | undefined;
};

/**
 * SSOT gate for the "far from location" confirmation feature.
 * Returns a blocking Response when the transition must not proceed yet;
 * returns null when the caller should continue (either within-range, no
 * coordinates to check, or a validly confirmed override — audit already
 * written in the confirmed case).
 */
async function guardFarFromLocation(ctx: FarFromLocationGateContext): Promise<Response | null> {
  const evaluation = evaluateFarFromLocationConfirmation({
    action: ctx.action,
    targetLat: ctx.targetLat,
    targetLng: ctx.targetLng,
    driverLat: ctx.driverLat,
    driverLng: ctx.driverLng,
    locationTimestampMs: ctx.locationTimestampMs,
    locationAccuracyM: ctx.locationAccuracyM,
    farConfirm: ctx.farConfirm,
  });

  if (evaluation.status === "not_applicable") {
    // Never invent coordinates — log and fall back to pre-feature behaviour.
    console.log("[stop-workflow] FAR_FROM_LOCATION_SKIPPED", {
      trip_id: ctx.tripId,
      action: ctx.action,
      stop_id: ctx.stopId,
      reason: evaluation.reason,
    });
    return null;
  }

  if (evaluation.status === "within_range") {
    return null;
  }

  if (evaluation.status === "confirmation_required") {
    console.log("[stop-workflow] FAR_FROM_LOCATION_CONFIRMATION_REQUIRED", {
      trip_id: ctx.tripId,
      driver_id: ctx.driverId,
      action: ctx.action,
      stop_id: ctx.stopId,
      distance_metres: evaluation.distance_metres,
      warning_radius_metres: evaluation.warning_radius_metres,
      reason: evaluation.reason,
    });
    return errorResponse(
      "LOCATION_CONFIRMATION_REQUIRED",
      farFromLocationBlockedMessage(ctx.action, evaluation.distance_metres),
      409,
      {
        distance_metres: evaluation.distance_metres,
        warning_radius_metres: evaluation.warning_radius_metres,
        reason: evaluation.reason,
        action: ctx.action,
        stop_id: ctx.stopId,
        target: { lat: ctx.targetLat, lng: ctx.targetLng },
      },
    );
  }

  // evaluation.status === "confirmed" — bound to this action + stop + target + fresh evidence.
  if (ctx.claimedStopId && ctx.stopId && ctx.claimedStopId !== ctx.stopId) {
    console.warn("[stop-workflow] FAR_FROM_LOCATION_STOP_MISMATCH", {
      trip_id: ctx.tripId,
      claimed_stop_id: ctx.claimedStopId,
      server_stop_id: ctx.stopId,
    });
  }

  await writeTripAudit(ctx.supabase, {
    trip_id: ctx.tripId,
    driver_id: ctx.driverId,
    event_type: farFromLocationAuditEventType(ctx.action),
    details: {
      lifecycle_action: ctx.action,
      stop_id: ctx.stopId,
      driver_lat: ctx.driverLat,
      driver_lng: ctx.driverLng,
      expected_lat: ctx.targetLat,
      expected_lng: ctx.targetLng,
      distance_metres: evaluation.distance_metres,
      warning_radius_metres: evaluation.warning_radius_metres,
      horizontal_accuracy_m: ctx.locationAccuracyM ?? null,
      location_timestamp: ctx.locationTimestampMs
        ? new Date(ctx.locationTimestampMs).toISOString()
        : null,
      confirmed_at: new Date().toISOString(),
      service_area_id: ctx.serviceAreaId ?? null,
      platform: ctx.platform ?? null,
    },
  });
  console.log("[stop-workflow] FAR_FROM_LOCATION_CONFIRMED", {
    trip_id: ctx.tripId,
    driver_id: ctx.driverId,
    action: ctx.action,
    stop_id: ctx.stopId,
    distance_metres: evaluation.distance_metres,
  });
  return null;
}

async function writeFareAudit(
  supabase: ReturnType<typeof createClient>,
  row: {
    trip_id: string;
    event_type: string;
    adjustment_pence?: number;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await supabase.from('fare_audit_logs').insert({
      trip_id: row.trip_id,
      event_type: row.event_type,
      adjustment_pence: row.adjustment_pence ?? null,
      metadata: row.metadata ?? {},
      created_at: new Date().toISOString(),
    });
  } catch (e) {
    console.warn('[stop-workflow] fare_audit_logs insert failed:', row.event_type, e);
  }
}

const TIP_WINDOW_MS = 2 * 60 * 1000;

/** True while customer may still add a tip (server SSOT + completed_at fallback). */
function isTipWindowOpen(trip: {
  tip_window_expires_at?: string | null;
  tip_window_closed_at?: string | null;
  completed_at?: string | null;
}): boolean {
  if (trip.tip_window_closed_at) return false;
  if (trip.tip_window_expires_at) {
    return new Date(trip.tip_window_expires_at).getTime() > Date.now();
  }
  if (trip.completed_at) {
    return Date.now() - new Date(trip.completed_at).getTime() < TIP_WINDOW_MS;
  }
  return false;
}

/** Card trips must capture via finalize-trip-and-capture — never mark captured without Stripe. */
async function invokeFinalizeTripCapture(
  supabaseUrl: string,
  serviceRoleKey: string,
  tripId: string,
  tipPence: number,
): Promise<{ ok: boolean; error?: string; body?: Record<string, unknown> }> {
  const result = await invokeFinalizeTripCaptureWithRetry({
    supabaseUrl,
    serviceRoleKey,
    tripId,
    tipPence,
    source: "stop-workflow:complete_trip",
  });
  return {
    ok: result.ok,
    error: result.error,
    body: result.body,
  };
}

async function fetchDispatchWaitingSettings(
  supabase: ReturnType<typeof createClient>,
  serviceAreaId: string | null,
): Promise<DispatchWaitingSettings> {
  const dispatchCols =
    'enable_stop_waiting_charge, stop_radius_enabled, stop_radius_meters, stop_waiting_charge_interval_seconds, stop_waiting_grace_period_seconds, stop_waiting_rate_pence_per_minute, stop_waiting_max_minutes, pickup_radius_enabled, pickup_radius_meters';
  const stopWaitingCols =
    'stop_radius_enabled, stop_radius_meters, stop_waiting_charge_interval_seconds, stop_waiting_grace_period_seconds, stop_waiting_rate_pence_per_minute, stop_waiting_max_minutes';

  let settings: DispatchWaitingSettings | null = null;

  if (serviceAreaId) {
    const { data } = await supabase
      .from('dispatch_settings')
      .select(dispatchCols)
      .eq('service_area_id', serviceAreaId)
      .maybeSingle();
    if (data) settings = data as DispatchWaitingSettings;
  }
  if (!settings) {
    const { data } = await supabase
      .from('dispatch_settings')
      .select(dispatchCols)
      .is('service_area_id', null)
      .maybeSingle();
    if (data) settings = data as DispatchWaitingSettings;
  }
  if (!settings) {
    const { data } = await supabase
      .from('dispatch_settings')
      .select(dispatchCols)
      .limit(1)
      .maybeSingle();
    if (data) settings = data as DispatchWaitingSettings;
  }

  const merged: DispatchWaitingSettings = { ...(settings ?? {}) };

  // Admin fare lifecycle saves stop radius to stop_waiting_settings — merge every check (no cache).
  let stopWaitingRow: Record<string, unknown> | null = null;
  if (serviceAreaId) {
    const { data } = await supabase
      .from('stop_waiting_settings')
      .select(stopWaitingCols)
      .eq('service_area_id', serviceAreaId)
      .maybeSingle();
    if (data) stopWaitingRow = data as Record<string, unknown>;
  }

  if (stopWaitingRow) {
    if (typeof stopWaitingRow.stop_radius_meters === 'number') {
      merged.stop_radius_meters = stopWaitingRow.stop_radius_meters;
      merged._stop_radius_source = 'stop_waiting_settings';
    }
    if (typeof stopWaitingRow.stop_radius_enabled === 'boolean') {
      merged.stop_radius_enabled = stopWaitingRow.stop_radius_enabled;
    }
    if (typeof stopWaitingRow.stop_waiting_charge_interval_seconds === 'number') {
      merged.stop_waiting_charge_interval_seconds = stopWaitingRow.stop_waiting_charge_interval_seconds;
    }
    if (typeof stopWaitingRow.stop_waiting_grace_period_seconds === 'number') {
      merged.stop_waiting_grace_period_seconds = stopWaitingRow.stop_waiting_grace_period_seconds;
    }
    if (typeof stopWaitingRow.stop_waiting_rate_pence_per_minute === 'number') {
      merged.stop_waiting_rate_pence_per_minute = stopWaitingRow.stop_waiting_rate_pence_per_minute;
    }
    if (stopWaitingRow.stop_waiting_max_minutes != null) {
      merged.stop_waiting_max_minutes = stopWaitingRow.stop_waiting_max_minutes as number | null;
    }
    if (merged.enable_stop_waiting_charge == null) {
      merged.enable_stop_waiting_charge = true;
    }
  }

  console.log('[stop-workflow] WAITING_RADIUS_DB_VALUE', {
    service_area_id: serviceAreaId,
    pickup_radius_meters: merged.pickup_radius_meters ?? null,
    stop_radius_meters: merged.stop_radius_meters ?? null,
    stop_radius_source: merged._stop_radius_source ?? 'dispatch_settings',
  });

  return merged;
}

/** Aggregate stop waiting into trips fare columns (customer/driver/admin SSOT). */
async function updateTripTotalWaiting(
  supabase: ReturnType<typeof createClient>,
  tripId: string,
): Promise<number> {
  const { data: allStops } = await supabase
    .from('trip_stops')
    .select('waiting_total_amount_pence')
    .eq('trip_id', tripId);

  const total = (allStops ?? []).reduce(
    (sum: number, s: { waiting_total_amount_pence?: number | null }) =>
      sum + (s.waiting_total_amount_pence || 0),
    0,
  );

  await supabase
    .from('trips')
    .update({
      total_waiting_charge_pence: total,
      stop_waiting_charge_pence: total,
      stop_charge_total_pence: total,
    })
    .eq('id', tripId);
  return total;
}

async function syncTripDestinationFields(
  supabase: ReturnType<typeof createClient>,
  tripId: string,
  stop: TripStopRow | null | undefined,
  extra: Record<string, unknown> = {},
): Promise<void> {
  if (!stop) return;
  await updateTripSafe(supabase, tripId, {
    current_stop_index: stop.stop_index ?? null,
    current_destination_index: stop.stop_index ?? null,
    current_destination_type: stop.type,
    current_stop_id: stop.id,
    ...extra,
  });
}

async function isStopWaitingChargeEnabled(
  supabase: ReturnType<typeof createClient>,
  serviceAreaId: string | null,
): Promise<boolean> {
  const settings = await fetchDispatchWaitingSettings(supabase, serviceAreaId);
  return settings.enable_stop_waiting_charge !== false;
}

/**
 * Finalize stop waiting charge (idempotent). Safe to call on every drive_to_next.
 */
async function finalizeStopWaitingCharge(
  supabase: ReturnType<typeof createClient>,
  trip: { id: string; service_area_id?: string | null },
  stop: {
    id: string;
    arrived_at?: string | null;
    waiting_charge_active?: boolean | null;
    waiting_started_at?: string | null;
    waiting_stopped_at?: string | null;
    waiting_total_amount_pence?: number | null;
  },
): Promise<{ chargePence: number; alreadyFinalized: boolean }> {
  if (stop.waiting_stopped_at) {
    return {
      chargePence: stop.waiting_total_amount_pence || 0,
      alreadyFinalized: true,
    };
  }

  if (!stop.waiting_charge_active || !stop.waiting_started_at) {
    return { chargePence: 0, alreadyFinalized: false };
  }

  const config = await loadAdminWaitingConfig(supabase, trip.service_area_id ?? null);
  const gracePeriod = config.free_stop_waiting_seconds;
  const ratePPM = config.stop_waiting_rate_pence_per_minute;
  const maxMinutes = config.stop_waiting_max_minutes;

  const anchorIso = stop.arrived_at ?? stop.waiting_started_at;
  const startedAt = new Date(anchorIso).getTime();
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  console.log("STOP_WAITING_ANCHOR_STOP_ARRIVED_AT", {
    trip_id: trip.id,
    stop_id: stop.id,
    stop_arrived_at: stop.arrived_at ?? null,
    elapsed_seconds: elapsedSeconds,
    free_stop_waiting_seconds: gracePeriod,
  });
  let chargeableSeconds = Math.max(0, elapsedSeconds - gracePeriod);

  if (maxMinutes && chargeableSeconds / 60 >= maxMinutes) {
    chargeableSeconds = maxMinutes * 60;
  }

  const totalPence = Math.round((chargeableSeconds / 60) * ratePPM);
  const stoppedAt = new Date().toISOString();

  await supabase
    .from('trip_stops')
    .update({
      waiting_charge_active: false,
      waiting_stopped_at: stoppedAt,
      waiting_total_amount_pence: totalPence,
      waiting_total_seconds: elapsedSeconds,
      last_waiting_charge_update_at: stoppedAt,
    })
    .eq('id', stop.id);

  await updateTripTotalWaiting(supabase, trip.id);

  return { chargePence: totalPence, alreadyFinalized: false };
}

/** Start stop waiting after driver taps Arrive at Stop (no GPS auto-start). */
async function startStopWaitingOnArrive(
  supabase: ReturnType<typeof createClient>,
  trip: { id: string; service_area_id?: string | null },
  stop: TripStopRow,
): Promise<{ started: boolean; idempotent: boolean; graceSeconds: number }> {
  if (stop.type !== 'stop') {
    return { started: false, idempotent: true, graceSeconds: 0 };
  }
  if (stop.waiting_charge_active && stop.waiting_started_at) {
    return { started: false, idempotent: true, graceSeconds: 0 };
  }

  const enabled = await isStopWaitingChargeEnabled(supabase, trip.service_area_id ?? null);
  if (!enabled) {
    return { started: false, idempotent: true, graceSeconds: 0 };
  }

  const config = await loadAdminWaitingConfig(supabase, trip.service_area_id ?? null);
  const graceSeconds = config.free_stop_waiting_seconds;
  const now = new Date().toISOString();
  const stopArrivedAt = stop.arrived_at ?? now;

  await supabase
    .from('trip_stops')
    .update({
      waiting_charge_active: true,
      waiting_started_at: stopArrivedAt,
      waiting_stopped_at: null,
      waiting_total_amount_pence: 0,
      waiting_total_seconds: 0,
      last_waiting_charge_update_at: now,
    })
    .eq('id', stop.id);

  const { error: mirrorErr } = await updateTripSafe(supabase, trip.id, {
    stop_arrived_at: stopArrivedAt,
    stop_waiting_started_at: stopArrivedAt,
    stop_waiting_free_seconds: graceSeconds,
    stop_waiting_paid_started_at: null,
    stop_waiting_finalized_at: null,
    stop_waiting_status: 'free_waiting',
    stop_waiting_charge_amount: 0,
    current_stop_index: stop.stop_index ?? null,
  });
  if (mirrorErr) {
    console.error('[stop-workflow] STOP_WAITING_TRIP_MIRROR_UPDATE_FAILED', {
      trip_id: trip.id,
      stop_id: stop.id,
      stop_index: stop.stop_index ?? null,
      error: mirrorErr.message,
    });
  } else {
    console.log('[stop-workflow] STOP_WAITING_TRIP_MIRROR_UPDATED', {
      trip_id: trip.id,
      stop_id: stop.id,
      stop_index: stop.stop_index ?? null,
      stop_waiting_started_at: stopArrivedAt,
    });
  }

  return { started: true, idempotent: false, graceSeconds };
}

/** True when admin SSOT requires GPS radius before stop arrive/waiting. */
async function isStopRadiusEnforced(
  supabase: ReturnType<typeof createClient>,
  serviceAreaId: string | null,
): Promise<boolean> {
  const settings = await fetchDispatchWaitingSettings(supabase, serviceAreaId);
  return settings.stop_radius_enabled ?? true;
}

/**
 * Revert orphan stop waiting when driver is outside admin radius.
 * Clears arrived_at so driver must re-confirm inside radius.
 */
async function clearStaleStopWaitingOutsideRadius(
  supabase: ReturnType<typeof createClient>,
  tripId: string,
  stop: TripStopRow,
  reason: string,
): Promise<void> {
  const now = new Date().toISOString();
  console.log('[stop-workflow] STOP_WAITING_CLEARED_OUTSIDE_RADIUS', {
    trip_id: tripId,
    stop_id: stop.id,
    stop_index: stop.stop_index ?? null,
    reason,
  });

  await supabase
    .from('trip_stops')
    .update({
      arrived_at: null,
      waiting_charge_active: false,
      waiting_started_at: null,
      waiting_stopped_at: null,
      waiting_total_amount_pence: 0,
      waiting_total_seconds: 0,
      last_waiting_charge_update_at: null,
      updated_at: now,
    })
    .eq('id', stop.id);

  await updateTripSafe(supabase, tripId, {
    stop_arrived_at: null,
    stop_waiting_started_at: null,
    stop_waiting_paid_started_at: null,
    stop_waiting_finalized_at: null,
    stop_waiting_status: 'none',
    stop_waiting_charge_amount: 0,
    updated_at: now,
  });
}

Deno.serve(async (req) => {
  const elapsed = startRequestTimer();
  const requestId = createRequestId();
  console.log("[stop-workflow] Request received:", req.method);

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return handleCORSPreflight();
  }

  // Rate limiting
  const clientIP = getClientIP(req);
  const rateLimitResult = checkRateLimit(clientIP, RATE_LIMIT_CONFIG);
  if (!rateLimitResult.allowed) {
    console.warn("[stop-workflow] Rate limit exceeded for IP:", clientIP);
    return rateLimitResponse(rateLimitResult);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    
    // Service role client for DB operations (bypasses RLS)
    const supabase = createClient(supabaseUrl, serviceRoleKey);
    
    // Auth header for user verification
    const authHeader = req.headers.get('Authorization');

    const body: WorkflowRequest = await req.json();
    const {
      trip_id,
      driver_id: requestedDriverId,
      action,
      driver_lat,
      driver_lng,
      cancel_reason,
      location_accuracy_m,
      location_timestamp,
      far_confirm,
      stop_id: claimedStopId,
      platform,
    } = body;
    const locationTimestampMs = parseLocationTimestampMs(location_timestamp);

    /** Always attach fresh trip + stops so clients render backend truth only. */
    const respondOk = async (payload: Record<string, unknown>) => {
      const duration_ms = elapsed();
      let tripSnapshot: Record<string, unknown> | null = null;
      let stopsSnapshot: unknown[] = [];
      try {
        const [{ data: tripRow }, { data: stopsRows }] = await Promise.all([
          supabase
            .from("trips")
            .select(
              "id, status, dispatch_status, arrived_at, pickup_arrived_at, started_at, completed_at, current_stop_index, current_stop_id, pickup_waiting_started_at, pickup_paid_waiting_started_at, pickup_waiting_charge_pence, stop_waiting_charge_pence, stop_charge_total_pence, final_fare_pence, final_customer_fare_pence, locked_base_fare_pence, driver_id, payment_status, payment_method, updated_at",
            )
            .eq("id", trip_id)
            .maybeSingle(),
          supabase
            .from("trip_stops")
            .select("*")
            .eq("trip_id", trip_id)
            .order("stop_index", { ascending: true }),
        ]);
        tripSnapshot = (tripRow as Record<string, unknown> | null) ?? null;
        stopsSnapshot = Array.isArray(stopsRows) ? stopsRows : [];
      } catch (snapErr) {
        console.warn("[stop-workflow] failed to attach trip snapshot", snapErr);
      }
      logRequestDuration("stop-workflow", duration_ms, { request_id: requestId, action, trip_id });
      finishEdgeRequestLog("stop-workflow", duration_ms, {
        request_id: requestId,
        action,
        trip_id,
      });
      return successResponse(
        withDuration(
          {
            ...payload,
            trip: payload.trip ?? tripSnapshot,
            stops: payload.stops ?? stopsSnapshot,
          },
          duration_ms,
          { source: "stop-workflow", requestId },
        ),
      );
    };

    console.log("[stop-workflow] Action:", action, "Trip:", trip_id, "Driver:", requestedDriverId);
    if (action === "arrive_pickup") {
      console.log("[stop-workflow] ARRIVED_TRANSITION_REQUEST", {
        trip_id,
        driver_id: requestedDriverId,
      });
    }

    // Input validation
    const validationErrors: Record<string, string> = {};

    if (!trip_id) {
      validationErrors.trip_id = "trip_id is required";
    } else if (!isValidUUID(trip_id)) {
      validationErrors.trip_id = "trip_id must be a valid UUID";
    }

    if (!action) {
      validationErrors.action = "action is required";
    } else if (!isValidAction(action, VALID_ACTIONS)) {
      validationErrors.action = `action must be one of: ${VALID_ACTIONS.join(', ')}`;
    }

    if (Object.keys(validationErrors).length > 0) {
      console.log("[stop-workflow] Validation failed:", validationErrors);
      return validationErrorResponse(validationErrors);
    }

    // SECURITY: Verify authenticated user and derive driver_id from JWT
    let driver_id: string;
    
    if (authHeader) {
      const auth = await requireAuthenticatedUser(req, supabaseUrl, anonKey);
      if (!auth.ok) {
        return auth.response;
      }
      const userId = auth.userId;
      const user = { id: userId };
      
      // Get driver_id from authenticated user
      const { data: driver, error: driverError } = await supabase
        .from('drivers')
        .select('id')
        .eq('user_id', user.id)
        .single();
      
      if (driverError || !driver) {
        console.log("[stop-workflow] Driver not found for user:", user.id);
        return errorResponse("FORBIDDEN", "Driver account not found for authenticated user", 403);
      }
      
      driver_id = driver.id;
      
      // Log if client sent a different driver_id (potential attack attempt)
      if (requestedDriverId && requestedDriverId !== driver_id) {
        console.warn("[stop-workflow] SECURITY: Client sent different driver_id. Claimed:", requestedDriverId, "Actual:", driver_id);
      }
    } else {
      // No auth header - check if this is a service role call (internal)
      if (!requestedDriverId) {
        return errorResponse("UNAUTHORIZED", "Authentication required", 401);
      }
      if (!isValidUUID(requestedDriverId)) {
        return errorResponse("BAD_REQUEST", "driver_id must be a valid UUID", 400);
      }
      driver_id = requestedDriverId;
      console.warn("[stop-workflow] SECURITY: Unauthenticated request using driver_id from body - this will be deprecated");
    }

    console.log("[stop-workflow] Authorized driver:", driver_id);

    // Fetch trip
    const { data: trip, error: tripError } = await supabase
      .from("trips")
      .select("*")
      .eq("id", trip_id)
      .single();

    if (tripError || !trip) {
      console.log("[stop-workflow] trip_not_found:", tripError);
      return errorResponse("trip_not_found", "Trip not found", 404);
    }

    // Verify driver authorization — assigned driver only (no offer auto-assign on terminal trips)
    const assignedDriverId =
      trip.confirmed_driver_id ?? trip.driver_id ?? null;

    if (isTripTerminalStatus(trip.status) && action !== "driver_cancel" && action !== "cancel_queued_stacked") {
      const s = normTripStatus(trip.status);
      const isCancelled = s.includes("cancelled") || s.includes("canceled") || s === "no_show";
      const errorCode = isCancelled ? "TRIP_CANCELLED" : "trip_terminal";
      console.log("[stop-workflow] trip_terminal:", trip_id, trip.status, action, "→", errorCode);
      return errorResponse(
        errorCode,
        isCancelled
          ? `Trip was cancelled (${trip.status}); action ${action} is not allowed`
          : `Trip is terminal (${trip.status}); action ${action} is not allowed`,
        409,
        { trip_status: trip.status },
      );
    }

    const isAuthorized = assignedDriverId === driver_id;

    if (!isAuthorized) {
      const { data: offer } = await supabase
        .from('ride_offers')
        .select('id, status')
        .eq('trip_id', trip_id)
        .eq('driver_id', driver_id)
        .in('status', ['pending', 'accepted'])
        .limit(1)
        .maybeSingle();

      if (!offer) {
        console.log("[stop-workflow] driver_not_assigned. confirmed:", trip.confirmed_driver_id, "requesting:", driver_id);
        return errorResponse(
          "driver_not_assigned",
          assignedDriverId
            ? "Trip was assigned to another driver"
            : "Driver is not assigned to this trip",
          403,
          { assigned_driver_id: assignedDriverId },
        );
      }

      if (isTripTerminalStatus(trip.status)) {
        return errorResponse(
          "trip_terminal",
          `Trip is terminal (${trip.status}); offer is no longer valid`,
          409,
          { trip_status: trip.status },
        );
      }

      // Driver has a valid offer on a live trip — assign them atomically
      console.log("[stop-workflow] Driver has active offer, assigning to trip");
      await supabase
        .from("trips")
        .update({
          driver_id: driver_id,
          confirmed_driver_id: driver_id,
          status: 'accepted',
          updated_at: new Date().toISOString(),
        })
        .eq("id", trip_id);

      trip.driver_id = driver_id;
      trip.confirmed_driver_id = driver_id;
      trip.status = 'accepted';
    }

    // Driver cancel SSOT — no stop progression required
    if (action === "cancel_queued_stacked") {
      const result = await executeDriverQueuedStackedCancel(supabase, trip_id, driver_id);
      if (!result.ok) {
        return errorResponse(result.code, result.message, result.status);
      }
      return await respondOk({ success: true, action: result.action, ...result.detail });
    }

    if (action === "driver_cancel") {
      const result = await executeDriverTerminalCancel(supabase, {
        tripId: trip_id,
        driverId: driver_id,
        cancelReason: cancel_reason ?? "",
        rawStatus: String(trip.status ?? ""),
        trip: trip as Record<string, unknown>,
      });
      if (!result.ok) {
        return errorResponse(result.code, result.message, result.status);
      }
      return await respondOk({ success: true, action: result.action, ...result.detail });
    }

    // Fetch all stops ordered by index
    let { data: stops, error: stopsError } = await supabase
      .from("trip_stops")
      .select("*")
      .eq("trip_id", trip_id)
      .order("stop_index", { ascending: true });

    if (stopsError) {
      console.error("[stop-workflow] Error fetching stops:", stopsError);
      return errorResponse("FETCH_ERROR", "Failed to fetch stops", 500);
    }

    // AUTO-CREATE STOPS IF MISSING (fallback for trips created without stops)
    if (!stops || stops.length === 0) {
      console.log("[stop-workflow] No stops found, auto-creating from trip data");
      
      const stopsToCreate = [
        {
          trip_id: trip_id,
          stop_index: 0,
          type: 'pickup',
          address: trip.pickup_address || 'Pickup',
          lat: trip.pickup_latitude || 0,
          lng: trip.pickup_longitude || 0,
          status: 'pending',
        },
        {
          trip_id: trip_id,
          stop_index: 1,
          type: 'dropoff',
          address: trip.dropoff_address || 'Dropoff',
          lat: trip.dropoff_latitude || 0,
          lng: trip.dropoff_longitude || 0,
          status: 'pending',
        },
      ];

      const { error: createError } = await supabase
        .from("trip_stops")
        .insert(stopsToCreate);

      if (createError) {
        console.error("[stop-workflow] Failed to auto-create stops:", createError);
        return errorResponse("CREATE_STOPS_ERROR", "Failed to create missing stops", 500);
      }

      // Fetch the newly created stops
      const { data: newStops } = await supabase
        .from("trip_stops")
        .select("*")
        .eq("trip_id", trip_id)
        .order("stop_index", { ascending: true });

      stops = newStops || [];
      console.log("[stop-workflow] Auto-created", stops.length, "stops");
    }

    const now = new Date().toISOString();
    const currentIndex = trip.current_stop_index || 0;
    const currentStop = stops?.find(s => s.stop_index === currentIndex);

    console.log("[stop-workflow] Current index:", currentIndex, "Stops count:", stops?.length, "Current stop status:", currentStop?.status);

    // Backend safety: queued stacked rides cannot be progressed until promoted
    if (trip.status === 'queued') {
      logStackedPromotionSkipped({
        trip_id,
        driver_id,
        action,
        queued_trip_id: trip_id,
        reason: "queued_trip_cannot_progress_before_promotion",
      });
      return errorResponse(
        "invalid_status",
        "Queued stacked ride cannot start before current trip is fully completed",
        409
      );
    }

    if (
      isTripTerminalStatus(trip.status) &&
      action !== 'complete_trip' &&
      action !== 'driver_cancel' &&
      action !== 'cancel_queued_stacked'
    ) {
      console.log("[stop-workflow] trip_terminal:", trip_id, trip.status, action);
      return errorResponse(
        "trip_terminal",
        `Trip is terminal (${trip.status}); action ${action} is not allowed`,
        409,
        { trip_status: trip.status },
      );
    }

    const lifecycleAction = mapStopWorkflowActionToLifecycleAction(action);
    if (lifecycleAction) {
      const lifecycleStops: TripStopRecord[] = (stops ?? []).map((s) => ({
        stop_index: s.stop_index,
        type: s.type as TripStopRecord["type"],
        status: s.status as TripStopRecord["status"],
        arrived_at: s.arrived_at ?? null,
      }));
      const lifecycleCheck = validateTripActionTransition(
        lifecycleAction,
        {
          status: trip.status,
          started_at: trip.started_at ?? null,
          arrived_at: trip.arrived_at ?? null,
          completed_at: trip.completed_at ?? null,
          current_stop_index: trip.current_stop_index ?? null,
        },
        lifecycleStops,
      );
      if (!lifecycleCheck.allowed && !lifecycleCheck.idempotent) {
        console.log("[stop-workflow] LIFECYCLE_TRANSITION_BLOCKED", {
          trip_id,
          driver_id,
          action,
          current_state: lifecycleCheck.current_state,
          reason: lifecycleCheck.reason,
        });
        return errorResponse(
          "INVALID_LIFECYCLE_TRANSITION",
          lifecycleCheck.reason ?? "Action not allowed for current trip state",
          409,
          { current_state: lifecycleCheck.current_state },
        );
      }
    }

    // Handle actions
    switch (action) {
      case 'start_journey_to_pickup': {
        const nowIso = new Date().toISOString();
        const scheduledAt = trip.scheduled_at as string | null;
        const airportChargePence = Number(trip.airport_charge_pence ?? 0);
        const existingStartedAt = trip.driver_started_journey_to_pickup_at as string | null;
        const currentStatus = String(trip.status || '').toLowerCase();

        // Assigned driver already authorised above (JWT → driver_id === trip assignment).
        const journeyDecision = resolveStartJourneyToPickupDecision({
          status: currentStatus,
          arrivedAt: typeof trip.arrived_at === 'string' ? trip.arrived_at : null,
          isArrivedStatus: ARRIVED_AT_PICKUP_STATUSES.has(currentStatus),
        });

        const loadJourneyTrip = async () => {
          const { data } = await supabase
            .from('trips')
            .select(
              'id, trip_code, status, dispatch_status, driver_id, confirmed_driver_id, assigned_at, driver_started_journey_to_pickup_at, pickup_address, pickup_latitude, pickup_longitude, dropoff_address, dropoff_latitude, dropoff_longitude, updated_at, started_at, arrived_at',
            )
            .eq('id', trip_id)
            .maybeSingle();
          return data;
        };

        if (journeyDecision.kind === 'reject') {
          return errorResponse(
            journeyDecision.code,
            journeyDecision.message,
            409,
            { trip_status: trip.status },
          );
        }

        // Idempotent: already en route.
        if (journeyDecision.kind === 'idempotent' || EN_ROUTE_TO_PICKUP_STATUSES.has(currentStatus)) {
          const snapshot = await loadJourneyTrip();
          console.log("[stop-workflow] DRIVER_STARTED_JOURNEY_TO_PICKUP", {
            trip_id,
            driver_id,
            idempotent: true,
            status: currentStatus,
            driver_started_journey_to_pickup_at:
              existingStartedAt ?? snapshot?.driver_started_journey_to_pickup_at ?? null,
          });
          return await respondOk({
            success: true,
            idempotent: true,
            action: 'start_journey_to_pickup',
            driver_started_journey_to_pickup_at:
              existingStartedAt ?? snapshot?.driver_started_journey_to_pickup_at ?? null,
            trip: snapshot ?? {
              id: trip_id,
              status: currentStatus,
              driver_started_journey_to_pickup_at: existingStartedAt,
            },
          });
        }

        if (!CAN_START_JOURNEY_FROM_STATUSES.has(currentStatus)) {
          return errorResponse(
            "invalid_status",
            `Cannot start journey to pickup from status ${trip.status}`,
            409,
            { trip_status: trip.status },
          );
        }

        const startedAt = existingStartedAt ?? nowIso;
        const { error: journeyUpdateError } = await updateTripSafe(supabase, trip_id, {
          status: CANONICAL_EN_ROUTE_TO_PICKUP,
          driver_started_journey_to_pickup_at: startedAt,
          updated_at: nowIso,
        });

        if (journeyUpdateError) {
          console.error("[stop-workflow] start_journey_to_pickup failed:", journeyUpdateError);
          return errorResponse("rpc_error", "Failed to start journey to pickup", 500, journeyUpdateError);
        }

        const snapshot = await loadJourneyTrip();
        console.log("[stop-workflow] DRIVER_STARTED_JOURNEY_TO_PICKUP", {
          trip_id,
          driver_id,
          status: CANONICAL_EN_ROUTE_TO_PICKUP,
          driver_started_journey_to_pickup_at: startedAt,
          scheduled: Boolean(scheduledAt),
          airport_charge_pence: airportChargePence,
        });

        // Preserve airport/scheduled protection logging when those fields apply.
        if (scheduledAt && airportChargePence > 0) {
          console.log("[stop-workflow] AIRPORT_PROTECTION_ACTIVATED", {
            trip_id,
            driver_id,
            airport_charge_pence: airportChargePence,
            scheduled_at: scheduledAt,
          });
        }

        return await respondOk({
          success: true,
          action: 'start_journey_to_pickup',
          driver_started_journey_to_pickup_at: startedAt,
          trip: snapshot ?? {
            id: trip_id,
            status: CANONICAL_EN_ROUTE_TO_PICKUP,
            driver_started_journey_to_pickup_at: startedAt,
          },
        });
      }

      case 'arrive_pickup': {
        const pickupStop = stops?.find(s => s.stop_index === 0);

        if (!pickupStop) {
          return errorResponse("NO_PICKUP", "Pickup stop not found", 400);
        }

        const tripAlreadyArrived = ARRIVED_AT_PICKUP_STATUSES.has(
          String(trip.status || '').toLowerCase()
        );
        // Multi-stop bookings may pre-set pickup status=current without arrived_at.
        // Arrival is recorded only when arrived_at is set (not status alone).
        const stopAlreadyArrived = !!pickupStop.arrived_at;

        const pickupLat = pickupStop.lat ?? trip.pickup_latitude ?? null;
        const pickupLng = pickupStop.lng ?? trip.pickup_longitude ?? null;
        const pickupDriverLat = typeof driver_lat === 'number' ? driver_lat : undefined;
        const pickupDriverLng = typeof driver_lng === 'number' ? driver_lng : undefined;

        // Idempotent: stop and trip both reflect arrival — try waiting start inside radius only
        if (stopAlreadyArrived && tripAlreadyArrived) {
          const waitingResult = await tryStartPickupWaiting(supabase, {
            tripId: trip_id,
            trip,
            pickupStop,
            pickupLat,
            pickupLng,
            driverLat: pickupDriverLat,
            driverLng: pickupDriverLng,
            now,
          });
          const { data: syncedTrip } = await supabase
            .from("trips")
            .select("id, status, arrived_at, pickup_waiting_started_at, updated_at, driver_id")
            .eq("id", trip_id)
            .single();
          console.log("[stop-workflow] ARRIVED_RPC_RESPONSE", {
            trip_id,
            idempotent: true,
            trip_status: trip.status,
            waiting_started: waitingResult.started,
            waiting_status: waitingResult.waiting_status,
          });
          return await respondOk(await enrichArrivalWaitingSnapshot(supabase, {
            success: true,
            idempotent: true,
            action: 'arrive_pickup',
            arrival_status: 'arrived',
            waiting_started: waitingResult.started,
            waiting_status: waitingResult.waiting_status,
            allowed_radius_meters: waitingResult.allowed_radius_meters ?? null,
            distance_meters: waitingResult.distance_meters ?? null,
            trip: syncedTrip ?? {
              id: trip_id,
              status: trip.status,
              arrived_at: trip.arrived_at,
              pickup_waiting_started_at: trip.pickup_waiting_started_at,
            },
          }, waitingResult, { scope: 'pickup', trip: syncedTrip ?? trip, trip_id }));
        }

        // Stop arrived but trip still pre-pickup — sync trip arrival (partial prior write)
        if (stopAlreadyArrived && !tripAlreadyArrived) {
          const arrivedAnchor = trip.arrived_at || pickupStop.arrived_at || now;
          const { error: syncTripError } = await updateTripSafe(supabase, trip_id, {
            status: CANONICAL_ARRIVED_STATUS,
            arrived_at: arrivedAnchor,
            pickup_arrived_at: arrivedAnchor,
            updated_at: now,
          });

          if (syncTripError) {
            console.error("[stop-workflow] ARRIVED_RPC_ERROR sync trip:", syncTripError);
            return errorResponse("rpc_error", "Failed to sync trip arrival status", 500, syncTripError);
          }

          console.log("[stop-workflow] ARRIVAL_MARKED_PICKUP_SUCCESS", {
            trip_id,
            driver_id,
            idempotent: true,
            synced_trip_status: true,
          });

          const waitingResult = await tryStartPickupWaiting(supabase, {
            tripId: trip_id,
            trip: { ...trip, arrived_at: arrivedAnchor, status: CANONICAL_ARRIVED_STATUS },
            pickupStop,
            pickupLat,
            pickupLng,
            driverLat: pickupDriverLat,
            driverLng: pickupDriverLng,
            now,
          });

          const { data: syncedTrip } = await supabase
            .from("trips")
            .select("id, status, arrived_at, pickup_waiting_started_at, updated_at, driver_id")
            .eq("id", trip_id)
            .single();

          console.log("[stop-workflow] ARRIVED_RPC_RESPONSE", {
            trip_id,
            idempotent: true,
            synced_trip_status: true,
            waiting_started: waitingResult.started,
            waiting_status: waitingResult.waiting_status,
          });
          return await respondOk(await enrichArrivalWaitingSnapshot(supabase, {
            success: true,
            idempotent: true,
            action: 'arrive_pickup',
            arrival_status: 'arrived',
            waiting_started: waitingResult.started,
            waiting_status: waitingResult.waiting_status,
            allowed_radius_meters: waitingResult.allowed_radius_meters ?? null,
            distance_meters: waitingResult.distance_meters ?? null,
            trip: syncedTrip,
          }, waitingResult, { scope: 'pickup', trip: syncedTrip ?? { ...trip, arrived_at: arrivedAnchor }, trip_id }));
        }

        if (trip.started_at || trip.status === 'in_progress') {
          return errorResponse(
            "INVALID_STATUS",
            "Trip already started; cannot mark arrived at pickup",
            409
          );
        }

        if (
          !CAN_ARRIVE_FROM_STATUSES.has(String(trip.status || '').toLowerCase()) &&
          !tripAlreadyArrived
        ) {
          console.log("[stop-workflow] ARRIVED_RPC_ERROR invalid status:", trip.status);
          return errorResponse(
            "INVALID_STATUS",
            `Cannot arrive at pickup from status: ${trip.status}`,
            409
          );
        }

        const pickupFarGateResponse = await guardFarFromLocation({
          supabase,
          tripId: trip_id,
          driverId: driver_id,
          action: 'arrive_pickup',
          stopId: pickupStop.id,
          targetLat: pickupLat,
          targetLng: pickupLng,
          driverLat: pickupDriverLat,
          driverLng: pickupDriverLng,
          locationAccuracyM: location_accuracy_m,
          locationTimestampMs,
          farConfirm: far_confirm,
          claimedStopId,
          serviceAreaId: trip.service_area_id ?? null,
          platform,
        });
        if (pickupFarGateResponse) return pickupFarGateResponse;

        const { error: stopUpdateError } = await supabase
          .from("trip_stops")
          .update({
            status: 'current' as StopStatus,
            arrived_at: now,
            updated_at: now,
          })
          .eq("id", pickupStop.id);

        if (stopUpdateError) {
          console.error("[stop-workflow] ARRIVED_RPC_ERROR stop:", stopUpdateError);
          return errorResponse("UPDATE_FAILED", "Failed to update pickup stop", 500);
        }

        const { error: tripUpdateError } = await updateTripSafe(supabase, trip_id, {
          status: CANONICAL_ARRIVED_STATUS,
          arrived_at: now,
          pickup_arrived_at: now,
          updated_at: now,
        });

        if (tripUpdateError) {
          console.error("[stop-workflow] ARRIVED_RPC_ERROR trip:", tripUpdateError);
          return errorResponse("rpc_error", "Failed to update trip status", 500, tripUpdateError);
        }

        console.log("[stop-workflow] ARRIVAL_MARKED_PICKUP_SUCCESS", {
          trip_id,
          driver_id,
        });

        const waitingResult = await tryStartPickupWaiting(supabase, {
          tripId: trip_id,
          trip: { ...trip, arrived_at: now, status: CANONICAL_ARRIVED_STATUS },
          pickupStop: { ...pickupStop, arrived_at: now },
          pickupLat,
          pickupLng,
          driverLat: pickupDriverLat,
          driverLng: pickupDriverLng,
          now,
        });

        const { data: updatedTrip } = await supabase
          .from("trips")
          .select("id, status, arrived_at, pickup_waiting_started_at, updated_at, driver_id")
          .eq("id", trip_id)
          .single();

        console.log("[stop-workflow] ARRIVED_RPC_RESPONSE", {
          trip_id,
          driver_id,
          trip_status: updatedTrip?.status,
          waiting_started: waitingResult.started,
          waiting_status: waitingResult.waiting_status,
        });
        await writeTripAudit(supabase, {
          trip_id,
          driver_id,
          event_type: 'ARRIVE_AT_PICKUP_TAPPED',
          details: { arrived_at: now },
        });
        if (waitingResult.started) {
          const isMultiStopTrip = (stops?.length ?? 0) > 2;
          await writeTripAudit(supabase, {
            trip_id,
            driver_id,
            event_type: 'PICKUP_WAITING_STARTED',
            details: { arrived_at: now, multi_stop: isMultiStopTrip },
          });
          if (isMultiStopTrip) {
            console.log('[stop-workflow] PICKUP_WAITING_STARTED_MULTI_STOP', {
              trip_id,
              driver_id,
              stops_count: stops?.length ?? 0,
              pickup_waiting_started_at: updatedTrip?.pickup_waiting_started_at ?? null,
            });
          }
        }
        return await respondOk(await enrichArrivalWaitingSnapshot(supabase, {
          success: true,
          action: 'arrive_pickup',
          arrival_status: 'arrived',
          waiting_started: waitingResult.started,
          waiting_status: waitingResult.waiting_status,
          allowed_radius_meters: waitingResult.allowed_radius_meters ?? null,
          distance_meters: waitingResult.distance_meters ?? null,
          trip: updatedTrip,
        }, waitingResult, { scope: 'pickup', trip: updatedTrip ?? { ...trip, arrived_at: now, pickup_arrived_at: now }, trip_id }));
      }

      case 'start_trip': {
        console.log("[stop-workflow] START_TRIP_PAYLOAD", {
          trip_id,
          driver_id,
          trip_status: trip.status,
          started_at: trip.started_at,
          current_stop_index: trip.current_stop_index,
        });

        const pickupStop = stops?.find(s => s.stop_index === 0);
        
        if (!pickupStop) {
          return errorResponse("invalid_status", "Pickup stop not found", 400);
        }

        if (isTripTerminalStatus(trip.status)) {
          return errorResponse(
            "trip_terminal",
            `Cannot start trip in status: ${trip.status}`,
            409,
            { trip_status: trip.status },
          );
        }

        // Auto-arrive at pickup if not yet arrived (handles race conditions)
        if (pickupStop.status !== 'current' && !pickupStop.arrived_at) {
          console.log("[stop-workflow] Auto-arriving at pickup before start_trip");
          await supabase
            .from("trip_stops")
            .update({ status: 'current' as StopStatus, arrived_at: now, updated_at: now })
            .eq("id", pickupStop.id);
          await supabase
            .from("trips")
            .update({
              status: CANONICAL_ARRIVED_STATUS,
              arrived_at: now,
              updated_at: now,
            })
            .eq("id", trip_id);
          pickupStop.status = 'current';
          pickupStop.arrived_at = now;
        }

        // Idempotency: already started
        if (trip.started_at) {
          console.log("[stop-workflow] Trip already started (idempotent)");
          return await respondOk({ success: true, idempotent: true, message: "Trip already started" });
        }

        // Mark pickup as completed
        await supabase
          .from("trip_stops")
          .update({ status: 'completed' as StopStatus, completed_at: now, updated_at: now })
          .eq("id", pickupStop.id);

        // Find next stop (index 1)
        const nextStop = stops?.find(s => s.stop_index === 1);
        const totalStops = stops?.length || 0;

        if (nextStop) {
          // Set next stop as current
          await supabase
            .from("trip_stops")
            .update({ status: 'current' as StopStatus, updated_at: now })
            .eq("id", nextStop.id);

          const { error: startTripUpdateError } = await updateTripSafe(supabase, trip_id, {
            started_at: now,
            status: 'in_progress' as TripStatus,
            current_stop_index: 1,
            current_destination_index: 1,
            current_destination_type: nextStop.type,
            current_stop_id: nextStop.id,
            stop_waiting_status: 'none',
            stop_arrived_at: null,
            stop_waiting_started_at: null,
            stop_waiting_paid_started_at: null,
            stop_waiting_finalized_at: null,
            stop_waiting_charge_amount: 0,
            updated_at: now,
          });

          if (startTripUpdateError) {
            console.error("[stop-workflow] START_TRIP trip update failed:", startTripUpdateError);
            return errorResponse("rpc_error", "Failed to start trip", 500, startTripUpdateError);
          }
        } else {
          const { error: startTripUpdateError } = await updateTripSafe(supabase, trip_id, {
            started_at: now,
            status: 'in_progress' as TripStatus,
            updated_at: now,
          });

          if (startTripUpdateError) {
            console.error("[stop-workflow] START_TRIP trip update failed:", startTripUpdateError);
            return errorResponse("rpc_error", "Failed to start trip", 500, startTripUpdateError);
          }
        }

        console.log("[stop-workflow] START_TRIP success, next stop:", nextStop?.stop_index || 'none');
        await writeTripAudit(supabase, {
          trip_id,
          driver_id,
          event_type: 'START_TRIP_TAPPED',
          details: { next_stop_index: nextStop?.stop_index ?? null },
        });
        return await respondOk({ success: true, action: 'start_trip', next_stop_index: nextStop?.stop_index || null });
      }

      case 'arrive_stop': {
        // Must have started trip
        if (!trip.started_at) {
          return errorResponse("NOT_STARTED", "Trip not started yet", 400);
        }

        if (!currentStop) {
          return errorResponse("NO_STOP", "No current stop found", 400);
        }

        if (currentStop.type === 'pickup') {
          return errorResponse("INVALID_STOP", "Use arrive_pickup for pickup", 400);
        }

        console.log("[stop-workflow] STOP_ARRIVE_TAP_RECEIVED", {
          trip_id,
          stop_id: currentStop.id,
          stop_index: currentStop.stop_index,
        });
        console.log("[stop-workflow] STOP_RADIUS_CHECK_STARTED", {
          trip_id,
          stop_id: currentStop.id,
          driver_lat: driver_lat ?? null,
          driver_lng: driver_lng ?? null,
        });

        const stopDriverLat = typeof driver_lat === 'number' ? driver_lat : undefined;
        const stopDriverLng = typeof driver_lng === 'number' ? driver_lng : undefined;

        // Idempotency: already arrived — try waiting start when inside radius
        if (currentStop.status === 'current' && currentStop.arrived_at) {
          const waitingResult = await tryStartStopWaiting(
            supabase,
            trip,
            currentStop,
            stopDriverLat,
            stopDriverLng,
          );

          console.log("[stop-workflow] Already arrived at stop (idempotent)", {
            waiting_started: waitingResult.started,
            waiting_status: waitingResult.waiting_status,
          });
          return await respondOk(await enrichArrivalWaitingSnapshot(supabase, {
            success: true,
            idempotent: true,
            action: 'arrive_stop',
            arrival_status: 'arrived',
            stop_id: currentStop.id,
            stop_index: currentStop.stop_index,
            waiting_started: waitingResult.started,
            waiting_status: waitingResult.waiting_status,
            allowed_radius_meters: waitingResult.allowed_radius_meters ?? null,
            distance_meters: waitingResult.distance_meters ?? null,
          }, waitingResult, { scope: 'stop', trip, stop: currentStop }));
        }

        const stopFarGateResponse = await guardFarFromLocation({
          supabase,
          tripId: trip_id,
          driverId: driver_id,
          action: 'arrive_stop',
          stopId: currentStop.id,
          targetLat: currentStop.lat,
          targetLng: currentStop.lng,
          driverLat: stopDriverLat,
          driverLng: stopDriverLng,
          locationAccuracyM: location_accuracy_m,
          locationTimestampMs,
          farConfirm: far_confirm,
          claimedStopId,
          serviceAreaId: trip.service_area_id ?? null,
          platform,
        });
        if (stopFarGateResponse) return stopFarGateResponse;

        // Record arrival first — waiting start is radius-gated separately
        await supabase
          .from("trip_stops")
          .update({ status: 'current' as StopStatus, arrived_at: now, updated_at: now })
          .eq("id", currentStop.id);

        await syncTripDestinationFields(supabase, trip_id, currentStop, {
          stop_arrived_at: now,
        });

        console.log("[stop-workflow] ARRIVAL_MARKED_STOP_SUCCESS", {
          trip_id,
          stop_id: currentStop.id,
          stop_index: currentStop.stop_index,
        });

        const waitingResult = await tryStartStopWaiting(
          supabase,
          trip,
          { ...currentStop, arrived_at: now },
          stopDriverLat,
          stopDriverLng,
        );

        await writeTripAudit(supabase, {
          trip_id,
          driver_id,
          event_type: 'ARRIVE_AT_STOP_TAPPED',
          details: { stop_id: currentStop.id, stop_index: currentStop.stop_index },
        });
        if (waitingResult.started) {
          await writeTripAudit(supabase, {
            trip_id,
            driver_id,
            event_type: 'STOP_WAITING_STARTED',
            details: {
              stop_id: currentStop.id,
              grace_seconds: waitingResult.graceSeconds,
            },
          });
        }

        console.log("[stop-workflow] ARRIVE_STOP success at index:", currentStop.stop_index);
        return await respondOk(await enrichArrivalWaitingSnapshot(supabase, {
          success: true,
          action: 'arrive_stop',
          arrival_status: 'arrived',
          stop_id: currentStop.id,
          stop_index: currentStop.stop_index,
          is_final: currentStop.type === 'dropoff',
          waiting_started: waitingResult.started,
          waiting_status: waitingResult.waiting_status,
          allowed_radius_meters: waitingResult.allowed_radius_meters ?? null,
          distance_meters: waitingResult.distance_meters ?? null,
        }, waitingResult, {
          scope: 'stop',
          trip: { ...trip, stop_arrived_at: now },
          stop: { ...currentStop, arrived_at: now },
        }));
      }

      case 'next_stop':
      case 'drive_to_next': {
        const workflowAction = action === 'drive_to_next' ? 'drive_to_next' : 'next_stop';

        // Must have started trip
        if (!trip.started_at) {
          return errorResponse("NOT_STARTED", "Trip not started yet", 400);
        }

        if (!currentStop) {
          return errorResponse("NO_STOP", "No current stop found", 400);
        }

        // Idempotent: stop already completed (double-tap Drive to Next)
        if (currentStop.status === 'completed') {
          const alreadyNext = stops?.find(
            (s) => s.stop_index > currentIndex && s.status === 'current',
          );
          if (alreadyNext) {
            console.log("[stop-workflow] drive_to_next idempotent — stop already advanced");
            return await respondOk({
              success: true,
              idempotent: true,
              action: workflowAction,
              previous_index: currentIndex,
              new_index: alreadyNext.stop_index,
              is_final: alreadyNext.type === 'dropoff',
            });
          }
        }

        // Intermediate stops require explicit Arrive at Stop before Drive to Next
        if (currentStop.type === 'stop' && !currentStop.arrived_at) {
          return errorResponse(
            "MUST_ARRIVE_AT_STOP",
            "Tap Arrive at Stop before driving to the next destination",
            409,
          );
        }

        if (currentStop.type === 'dropoff') {
          return errorResponse(
            "USE_COMPLETE_TRIP",
            "At final destination — use Complete Trip",
            409,
          );
        }

        await writeTripAudit(supabase, {
          trip_id,
          driver_id,
          event_type: 'DRIVE_TO_NEXT_TAPPED',
          details: { stop_id: currentStop.id, stop_index: currentStop.stop_index },
        });

        console.log("[stop-workflow] STOP_WAITING_END_REQUESTED", {
          trip_id,
          stop_id: currentStop.id,
          stop_index: currentStop.stop_index,
        });

        // Atomic: finalize waiting, add to fare total, then complete stop
        const { data: stopForFinalize } = await supabase
          .from('trip_stops')
          .select(
            'id, waiting_charge_active, waiting_started_at, waiting_stopped_at, waiting_total_amount_pence',
          )
          .eq('id', currentStop.id)
          .single();

        const finalizeResult = await finalizeStopWaitingCharge(
          supabase,
          trip,
          stopForFinalize ?? currentStop,
        );

        console.log("[stop-workflow] STOP_WAITING_ENDED_BACKEND_ACCEPTED", {
          trip_id,
          stop_id: currentStop.id,
          charge_pence: finalizeResult.chargePence,
          already_finalized: finalizeResult.alreadyFinalized,
        });

        if (!finalizeResult.alreadyFinalized) {
          await writeTripAudit(supabase, {
            trip_id,
            driver_id,
            event_type: 'STOP_WAITING_FINALIZED',
            details: {
              stop_id: currentStop.id,
              charge_pence: finalizeResult.chargePence,
            },
          });
          if (finalizeResult.chargePence > 0) {
            await writeFareAudit(supabase, {
              trip_id,
              event_type: 'STOP_WAITING_CHARGE_ADDED_TO_FARE',
              adjustment_pence: finalizeResult.chargePence,
              metadata: { stop_id: currentStop.id },
            });
          }
        }

        await updateTripSafe(supabase, trip_id, {
          stop_waiting_finalized_at: now,
          stop_waiting_status: 'finalized',
          stop_waiting_charge_amount: finalizeResult.chargePence,
          updated_at: now,
        });

        // Mark current stop completed (do not re-finalize waiting on retry)
        await supabase
          .from("trip_stops")
          .update({
            status: 'completed' as StopStatus,
            arrived_at: currentStop.arrived_at || now,
            completed_at: now,
            updated_at: now,
          })
          .eq("id", currentStop.id);

        // Find next available stop (skip any SKIPPED)
        const nextStops = stops?.filter(s => s.stop_index > currentIndex && s.status !== 'skipped') || [];
        const nextStop = nextStops.length > 0 ? nextStops[0] : null;

        if (nextStop) {
          // Set next stop as current
          await supabase
            .from("trip_stops")
            .update({ status: 'current' as StopStatus, updated_at: now })
            .eq("id", nextStop.id);

          const { error: advanceErr } = await updateTripSafe(supabase, trip_id, {
            current_stop_index: nextStop.stop_index,
            current_destination_index: nextStop.stop_index,
            current_destination_type: nextStop.type,
            current_stop_id: nextStop.id,
            stop_arrived_at: null,
            stop_waiting_started_at: null,
            stop_waiting_paid_started_at: null,
            stop_waiting_finalized_at: null,
            stop_waiting_status: nextStop.type === 'stop' ? 'none' : null,
            stop_waiting_charge_amount: 0,
            updated_at: now,
          });
          if (advanceErr) {
            console.error("[stop-workflow] drive_to_next trip update failed:", advanceErr);
            return errorResponse("rpc_error", "Failed to advance trip", 500, advanceErr);
          }

          await writeTripAudit(supabase, {
            trip_id,
            driver_id,
            event_type: 'TRIP_ADVANCED_TO_NEXT_DESTINATION',
            details: {
              from_index: currentIndex,
              to_index: nextStop.stop_index,
              next_stop_id: nextStop.id,
            },
          });

          console.log("[stop-workflow] NEXT_STOP success:", currentIndex, "->", nextStop.stop_index);
          return await respondOk({
            success: true,
            action: workflowAction,
            previous_index: currentIndex,
            new_index: nextStop.stop_index,
            is_final: nextStop.type === 'dropoff',
            waiting_charge_pence: finalizeResult.chargePence,
          });
        } else {
          // No more stops - this shouldn't happen if workflow is followed correctly
          console.log("[stop-workflow] No next stop available");
          return errorResponse("NO_NEXT_STOP", "No more stops available", 400);
        }
      }

      case 'complete_trip': {
        // Must have started trip
        if (!trip.started_at) {
          return errorResponse("NOT_STARTED", "Trip not started yet", 400);
        }

        // Idempotency: already completed
        if (trip.status === 'completed') {
          console.log("[stop-workflow] Trip already completed (idempotent)");
          return await respondOk({ success: true, idempotent: true, message: "Trip already completed" });
        }

        const finalStop = stops?.find(s => s.type === 'dropoff');
        if (!finalStop) {
          return errorResponse("NO_DROPOFF", "Final stop not found", 400);
        }

        const dropoffLat = finalStop.lat ?? trip.dropoff_latitude ?? null;
        const dropoffLng = finalStop.lng ?? trip.dropoff_longitude ?? null;
        const completeDriverLat = typeof driver_lat === 'number' ? driver_lat : undefined;
        const completeDriverLng = typeof driver_lng === 'number' ? driver_lng : undefined;
        const dropoffFarGateResponse = await guardFarFromLocation({
          supabase,
          tripId: trip_id,
          driverId: driver_id,
          action: 'complete_trip',
          stopId: finalStop.id,
          targetLat: dropoffLat,
          targetLng: dropoffLng,
          driverLat: completeDriverLat,
          driverLng: completeDriverLng,
          locationAccuracyM: location_accuracy_m,
          locationTimestampMs,
          farConfirm: far_confirm,
          claimedStopId,
          serviceAreaId: trip.service_area_id ?? null,
          platform,
        });
        if (dropoffFarGateResponse) return dropoffFarGateResponse;

        // P0: Close any open intermediate stop waiting before completion (multi-stop SSOT).
        for (const stopRow of stops ?? []) {
          if (
            stopRow.type === 'stop' &&
            stopRow.waiting_charge_active &&
            !stopRow.waiting_stopped_at
          ) {
            await finalizeStopWaitingCharge(supabase, trip, stopRow);
          }
        }
        await updateTripTotalWaiting(supabase, trip_id);

        const { data: tripBeforeComplete } = await supabase
          .from("trips")
          .select("*")
          .eq("id", trip_id)
          .single();

        const resolvedFare = resolveTripFare((tripBeforeComplete ?? trip) as TripFareRow);
        const finalFarePence = resolvedFare.final_fare_pence;
        const finalFareMajor = finalFarePence / 100;
        const totalWaitingPence =
          resolvedFare.arrival_waiting_charge_pence + resolvedFare.stop_waiting_charge_pence;

        // ── PHASE 1: Complete stops + trip status + resolve commission (PARALLEL) ──
        const incompleteStopIds = (stops || [])
          .filter(s => s.status !== 'completed' && s.status !== 'skipped')
          .map(s => s.id);

        const [, , commissionResult, driverRegionResult] = await Promise.all([
          incompleteStopIds.length > 0
            ? supabase
                .from("trip_stops")
                .update({
                  status: 'completed' as StopStatus,
                  completed_at: now,
                  arrived_at: now,
                  updated_at: now,
                })
                .in("id", incompleteStopIds)
            : Promise.resolve(),
          supabase
            .from("trips")
            .update({
              status: 'completed' as TripStatus,
              // SSOT: dispatch_status must be 'completed' simultaneously with status='completed'.
              // Admin panel reads dispatch_status — without this, trips appear stuck in prior state.
              // promote_stacked_trip also sets 'completed' on Trip A; this is the primary write.
              dispatch_status: 'completed',
              completed_at: now,
              fare: finalFareMajor,
              estimated_fare: finalFareMajor,
              final_fare_pence: finalFarePence,
              final_customer_fare_pence:
                nonNegInt((tripBeforeComplete ?? trip).final_customer_fare_pence) || finalFarePence,
              pickup_waiting_charge_pence: resolvedFare.arrival_waiting_charge_pence,
              stop_waiting_charge_pence: resolvedFare.stop_waiting_charge_pence,
              stop_charge_total_pence: resolvedFare.stop_waiting_charge_pence,
              total_waiting_charge_pence: totalWaitingPence,
              waiting_charge_pence: totalWaitingPence,
              updated_at: now,
            })
            .eq("id", trip_id),
          getDriverCommission(supabase, driver_id, (tripBeforeComplete ?? trip).service_area_id),
          supabase
            .from('drivers')
            .select('region_id, total_trips, regions(currency_code)')
            .eq('id', driver_id)
            .single(),
        ]);

        // Check for a queued stacked trip before clearing current_trip_id
        const hasStackedTrip = trip.stacked_trip_id != null;

        if (!hasStackedTrip) {
          // No stacked trip — clear current_trip_id (fire-and-forget is fine here)
          await supabase
            .from("drivers")
            .update({ current_trip_id: null, updated_at: now })
            .eq("id", driver_id);
        } else {
          console.log("[stop-workflow] Stacked trip exists:", trip.stacked_trip_id, "- keeping current_trip_id for post-trip promotion");
        }

        // ── PHASE 2: SSOT fare + payment (P0: card → finalize-trip-and-capture) ──
        const { data: tripAfterComplete } = await supabase
          .from("trips")
          .select("*")
          .eq("id", trip_id)
          .single();

        const fareTrip = tripAfterComplete ?? trip;
        const regionData = driverRegionResult?.data?.regions as { currency_code?: string } | null;
        const ledgerCurrency = regionData?.currency_code || null;

        const CS_MAP: Record<string, string> = { GBP:'£',USD:'$',EUR:'€',INR:'₹',AED:'د.إ',CAD:'C$',AUD:'A$',KES:'KSh',NGN:'₦',ZAR:'R',PKR:'₨',BDT:'৳' };
        const cs = ledgerCurrency ? (CS_MAP[ledgerCurrency.toUpperCase()] || '') : '';

        const { commissionPct } = commissionResult;
        const tipAmountPence = fareTrip.tip_amount_pence || fareTrip.tip_pence || 0;
        const isCash = (fareTrip.payment_method ?? "").toLowerCase() === "cash";
        const isOperationalCash = isCash && Boolean(fareTrip.cash_authorized_at);
        const hasStripePi = !!fareTrip.stripe_payment_intent_id;

        const settlement = calculateTripSettlement({
          final_fare_pence: finalFarePence,
          airport_charge_pence: resolvedFare.airport_charge_pence,
          other_pass_through_charges_pence: resolvedFare.pass_through_charge_pence,
          tips_pence: tipAmountPence,
          driver_tier_commission_percent: Number(
            fareTrip.driver_tier_commission_percent ?? commissionPct,
          ),
        });
        const commissionableFarePence = settlement.commissionable_fare_pence;
        const commissionPence = settlement.commission_pence;
        const driverNetBeforeTip = settlement.driver_net_pence;
        const driverTotalEarnings = settlement.driver_total_earnings_pence;

        console.log("[stop-workflow] SSOT fare breakdown:", JSON.stringify({
          finalFarePence,
          stop_waiting_charge_pence: resolvedFare.stop_waiting_charge_pence,
          pickup_waiting_charge_pence: resolvedFare.arrival_waiting_charge_pence,
          commissionableFarePence,
          commissionPct: settlement.tier_percent_used,
          commissionPence,
          driverNetBeforeTip,
          tipAmountPence,
          driverTotalEarnings,
          isCash,
          hasStripePi,
          ledgerCurrency,
        }));

        // Increment driver's total_trips (parallel with ledger work)
        const currentTotalTrips = driverRegionResult?.data?.total_trips || 0;
        const tripIncrementPromise = supabase
          .from("drivers")
          .update({ total_trips: currentTotalTrips + 1 })
          .eq("id", driver_id);

        // P0: Card / Apple Pay / Google Pay — capture fare immediately at trip completion.
        // Optional tips use a separate post-capture path; they do not block fare capture.
        if (!isCash && hasStripePi) {
          const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
          const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
          console.log("[PAYMENT_AUDIT]", JSON.stringify({
            stage: "auto_capture_trigger",
            trip_id,
            payment_intent_id: fareTrip.stripe_payment_intent_id,
            source: "stop-workflow:complete_trip",
          }));
          const finalizeResult = await invokeFinalizeTripCapture(
            supabaseUrl,
            serviceRoleKey,
            trip_id,
            0,
          );
          if (!finalizeResult.ok) {
            console.error("[stop-workflow] finalize-trip-and-capture failed:", finalizeResult.error);
            const { recordTripCaptureFailure } = await import("../_shared/digitalPaymentCapture.ts");
            await recordTripCaptureFailure(
              supabase,
              trip_id,
              finalizeResult.error ?? "Auto capture failed",
              fareTrip.stripe_payment_intent_id,
            );
            if (hasStackedTrip && trip.stacked_trip_id) {
              await handleQueuedTripAfterPaymentFailure(supabase, {
                currentTripId: trip_id,
                driverId: driver_id,
                paymentStatus: "capture_failed",
              });
            }
          } else {
            console.log("[stop-workflow] finalize-trip-and-capture invoked", finalizeResult.body);
          }
        }

        const skipCardLedgerInStopWorkflow = !isCash && hasStripePi;
        if ((commissionableFarePence > 0 || tipAmountPence > 0) && !skipCardLedgerInStopWorkflow) {
          if (isCash && !isOperationalCash) {
            // Historical legacy cash trips — fare snapshot only; no cash settlement ledger.
            await Promise.all([
              supabase.from("trips").update({
                ...tripSettlementDbColumns(settlement),
                tip_amount_pence: tipAmountPence,
                tip_pence: tipAmountPence,
                final_fare_pence: finalFarePence,
                final_customer_fare_pence:
                  nonNegInt(fareTrip.final_customer_fare_pence) || finalFarePence,
              }).eq("id", trip_id),
              tripIncrementPromise,
            ]);
          } else {
          // Check all existing ledger entries in parallel
          const ledgerTypes = isOperationalCash
            ? ['CASH_COMMISSION_DEBT', 'CASH_TRIP_EARNING', 'PLATFORM_COMMISSION']
            : ['TRIP_EARNING_NET', 'PLATFORM_COMMISSION'];
          if (tipAmountPence > 0) ledgerTypes.push('DRIVER_TIP_CREDIT');

          const existingChecks = await Promise.all(
            ledgerTypes.map(type =>
              supabase
                .from("driver_wallet_ledger")
                .select("id")
                .eq("related_trip_id", trip_id)
                .eq("type", type)
                .maybeSingle()
                .then(r => ({ type, exists: !!r.data }))
            )
          );
          const existsMap = Object.fromEntries(existingChecks.map(c => [c.type, c.exists]));

          // Build all inserts + trip fare update in parallel
          const parallelOps: any[] = [];

          const tripFareUpdate: Record<string, unknown> = {
            ...tripSettlementDbColumns(settlement),
            tip_amount_pence: tipAmountPence,
            tip_pence: tipAmountPence,
            final_fare_pence: finalFarePence,
            final_customer_fare_pence:
              nonNegInt(fareTrip.final_customer_fare_pence) || finalFarePence,
          };
          if (isOperationalCash) {
            tripFareUpdate.payment_status = "collected_cash";
          }
          // Card payment_status is owned by finalize-trip-and-capture + stripe-webhook

          parallelOps.push(
            supabase.from("trips").update(tripFareUpdate).eq("id", trip_id),
          );

          if (isOperationalCash) {
            if (!existsMap['CASH_COMMISSION_DEBT']) {
              parallelOps.push(
                supabase.from("driver_wallet_ledger").insert({
                  driver_id,
                  related_trip_id: trip_id,
                  type: 'CASH_COMMISSION_DEBT',
                  amount_pence: -commissionPence,
                  currency: ledgerCurrency || 'GBP',
                  description: `Cash trip commission due (${settlement.tier_percent_used}% of ${cs}${(commissionableFarePence / 100).toFixed(2)})`,
                })
              );
            }
            if (!existsMap['CASH_TRIP_EARNING']) {
              const grossCashFare = commissionableFarePence + settlement.airport_charge_pence + settlement.other_pass_through_charges_pence;
              parallelOps.push(
                supabase.from("driver_wallet_ledger").insert({
                  driver_id,
                  related_trip_id: trip_id,
                  type: 'CASH_TRIP_EARNING',
                  amount_pence: grossCashFare,
                  currency: ledgerCurrency || 'GBP',
                  description: `Cash trip gross fare collected (${cs}${(grossCashFare / 100).toFixed(2)})`,
                })
              );
            }
          } else if (!existsMap['TRIP_EARNING_NET']) {
            parallelOps.push(
              supabase.from("driver_wallet_ledger").insert({
                driver_id,
                related_trip_id: trip_id,
                type: 'TRIP_EARNING_NET',
                amount_pence: driverNetBeforeTip,
                currency: ledgerCurrency || 'GBP',
                description: `Trip earnings (fare ${cs}${(commissionableFarePence / 100).toFixed(2)} - ${settlement.tier_percent_used}% commission)`,
              })
            );
          }

          if (!existsMap['PLATFORM_COMMISSION']) {
            parallelOps.push(
              supabase.from("driver_wallet_ledger").insert({
                driver_id,
                related_trip_id: trip_id,
                type: 'PLATFORM_COMMISSION',
                amount_pence: commissionPence,
                currency: ledgerCurrency || 'GBP',
                description: `Platform commission ${settlement.tier_percent_used}% on ${cs}${(commissionableFarePence / 100).toFixed(2)} (${isOperationalCash ? 'cash' : 'card'})`,
              })
            );
          }

          if (tipAmountPence > 0 && !existsMap['DRIVER_TIP_CREDIT']) {
            parallelOps.push(
              supabase.from("driver_wallet_ledger").insert({
                driver_id,
                related_trip_id: trip_id,
                type: 'DRIVER_TIP_CREDIT',
                amount_pence: tipAmountPence,
                currency: ledgerCurrency || 'GBP',
                description: `Tip from passenger (${cs}${(tipAmountPence / 100).toFixed(2)})`,
              })
            );
          }

          // Fire all ledger inserts + fare update + trip increment in parallel
          parallelOps.push(tripIncrementPromise);
          await Promise.all(parallelOps);
          }
        } else {
          // No fare — just increment trips
          await tripIncrementPromise;
        }

        await writeTripAudit(supabase, {
          trip_id,
          driver_id,
          event_type: 'COMPLETE_TRIP_TAPPED',
          details: { final_stop_index: finalStop.stop_index },
        });

        // Server-side stacked promotion — do not wait for driver post-trip rating UI.
        if (hasStackedTrip && trip.stacked_trip_id) {
          const promotion = await tryPromoteStackedTripAfterCompletion(
            supabase,
            driver_id,
            trip_id,
          );
          console.log("[stop-workflow] STACKED_TRIP_PROMOTION_AFTER_COMPLETE", {
            completed_trip_id: trip_id,
            stacked_trip_id: trip.stacked_trip_id,
            promoted: promotion.promoted,
            detail: promotion.detail ?? null,
          });
        }

        console.log("[stop-workflow] COMPLETE_TRIP success");
        return await respondOk({ success: true, action: 'complete_trip' });
      }

      default:
        return errorResponse("INVALID_ACTION", `Unknown action: ${action}`, 400);
    }

  } catch (error) {
    console.error("[stop-workflow] Error:", error);
    return errorResponse("INTERNAL_ERROR", "Internal server error", 500);
  }
});
