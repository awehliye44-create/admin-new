import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { requireAuthenticatedUser } from "../_shared/edgeAuth.ts";
import { getDriverCommissionPct } from "../_shared/commission.ts";
import { resolveTripFare, type TripFareRow } from "../_shared/tripFareSSOT.ts";
import {
  buildSettlementTripRow,
  calculateTripSettlementFromTripRow,
  resolveTripTierPercent,
  tripSettlementDbColumns,
} from "../_shared/tripSettlement.ts";
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
  computePickupWaitingChargePence,
  loadAdminWaitingConfig,
  resolveFrozenOrLiveWaitingConfig,
  type AdminWaitingConfigSnapshot,
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
  logRequestDuration,
  startRequestTimer,
  withDuration,
  createRequestId,
  finishEdgeRequestLog,
} from "../_shared/edgeRequestTiming.ts";
import { invokeFinalizeTripCapture as invokeFinalizeTripCaptureWithRetry } from "../_shared/invokeFinalizeTripCapture.ts";
import {
  isCardPaymentMethod,
  recordTripCaptureFailure,
  requiresProviderSettlement,
} from "../_shared/digitalPaymentCapture.ts";
import { tripProviderOrderId } from "../_shared/tripPaymentProviderSSOT.ts";

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
  'pickup_paid_waiting_started_at',
  'pickup_waiting_finalized_at',
  'pickup_waiting_intervals_charged',
  'pickup_waiting_chargeable_seconds',
  'pickup_waiting_last_tick_at',
  'free_wait_expires_at',
  'grace_period_expired_at',
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

/**
 * Atomically create/start exactly one pickup waiting instance on Arrived.
 * Idempotent: never reset an existing pickup_waiting_started_at.
 * Never backfill started_at from arrived_at for a late start.
 */
async function ensurePickupWaitingStarted(
  supabase: ReturnType<typeof createClient>,
  tripId: string,
  trip: { arrived_at?: string | null; pickup_waiting_started_at?: string | null },
  pickupStop: { id: string; arrived_at?: string | null; waiting_started_at?: string | null } | null | undefined,
  now: string,
): Promise<{ ok: true; startedAt: string } | { ok: false; error: string }> {
  if (trip.pickup_waiting_started_at) {
    return { ok: true, startedAt: trip.pickup_waiting_started_at };
  }
  const waitingStartAt = now;
  const tripPayload: Record<string, unknown> = {
    pickup_waiting_started_at: waitingStartAt,
    updated_at: now,
  };
  if (trip.arrived_at) {
    tripPayload.pickup_arrived_at = trip.arrived_at;
  }
  const { error } = await updateTripSafe(supabase, tripId, tripPayload);
  if (error) {
    console.error('[stop-workflow] PICKUP_WAITING_START_FAILED', {
      trip_id: tripId,
      message: error.message,
    });
    return { ok: false, error: error.message };
  }
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
  return { ok: true, startedAt: waitingStartAt };
}

/**
 * Freeze pickup waiting on Start Trip: final amount once, no further ticks.
 * Rounding: completed intervals only (see computePickupWaitingChargePence).
 */
async function finalizePickupWaitingOnStartTrip(
  supabase: ReturnType<typeof createClient>,
  trip: TripWaitingBillingCtx & { id?: string; stop_waiting_charge_pence?: number | null },
  tripId: string,
  nowIso: string,
): Promise<{
  pickup_waiting_charge_pence: number;
  intervals_charged: number;
  already_finalized: boolean;
}> {
  if (trip.pickup_waiting_finalized_at) {
    return {
      pickup_waiting_charge_pence: trip.pickup_waiting_charge_pence ?? 0,
      intervals_charged: trip.pickup_waiting_intervals_charged ?? 0,
      already_finalized: true,
    };
  }

  const startedAt =
    typeof trip.pickup_waiting_started_at === 'string' && trip.pickup_waiting_started_at.trim()
      ? trip.pickup_waiting_started_at
      : null;

  if (!startedAt) {
    await updateTripSafe(supabase, tripId, {
      pickup_waiting_finalized_at: nowIso,
      pickup_waiting_charge_pence: trip.pickup_waiting_charge_pence ?? 0,
      pickup_waiting_intervals_charged: 0,
      updated_at: nowIso,
    });
    return {
      pickup_waiting_charge_pence: trip.pickup_waiting_charge_pence ?? 0,
      intervals_charged: 0,
      already_finalized: false,
    };
  }

  const live = await loadAdminWaitingConfig(
    supabase,
    trip.service_area_id ?? null,
    trip.vehicle_type_id ?? null,
  );
  const config = resolveFrozenOrLiveWaitingConfig(trip.pickup_waiting_admin_config, live);

  if (!config.pickup_paid_waiting_enabled || !config.config_available) {
    await updateTripSafe(supabase, tripId, {
      pickup_waiting_finalized_at: nowIso,
      pickup_waiting_charge_pence: 0,
      pickup_waiting_intervals_charged: 0,
      free_wait_expires_at:
        trip.free_wait_expires_at ??
        new Date(
          new Date(startedAt).getTime() + config.free_pickup_waiting_seconds * 1000,
        ).toISOString(),
      updated_at: nowIso,
    });
    return { pickup_waiting_charge_pence: 0, intervals_charged: 0, already_finalized: false };
  }

  const elapsedSeconds = Math.max(
    0,
    Math.floor((new Date(nowIso).getTime() - new Date(startedAt).getTime()) / 1000),
  );
  const paidSeconds = Math.max(0, elapsedSeconds - config.free_pickup_waiting_seconds);
  const charged = computePickupWaitingChargePence({
    paidSeconds,
    ratePencePerMinute: config.pickup_paid_waiting_rate_pence_per_minute,
    intervalSeconds: config.waiting_charge_interval_seconds,
    maxMinutes: config.pickup_waiting_max_minutes,
  });

  const stopWaiting = trip.stop_waiting_charge_pence ?? 0;
  const updatePayload: Record<string, unknown> = {
    pickup_waiting_finalized_at: nowIso,
    pickup_waiting_charge_pence: charged.charge_pence,
    pickup_waiting_intervals_charged: charged.intervals_charged,
    pickup_waiting_chargeable_seconds: charged.paid_seconds_capped,
    pickup_waiting_last_tick_at: nowIso,
    total_waiting_charge_pence: charged.charge_pence + stopWaiting,
    waiting_charge_pence: charged.charge_pence + stopWaiting,
    updated_at: nowIso,
  };
  if (!trip.pickup_paid_waiting_started_at && charged.charge_pence > 0) {
    updatePayload.pickup_paid_waiting_started_at = new Date(
      new Date(startedAt).getTime() + config.free_pickup_waiting_seconds * 1000,
    ).toISOString();
  }
  if (!trip.grace_period_expired_at && paidSeconds > 0) {
    updatePayload.grace_period_expired_at = new Date(
      new Date(startedAt).getTime() + config.free_pickup_waiting_seconds * 1000,
    ).toISOString();
  }

  await updateTripSafe(supabase, tripId, updatePayload);
  console.log('[stop-workflow] PICKUP_WAITING_FINALIZED_ON_START_TRIP', {
    trip_id: tripId,
    pickup_waiting_charge_pence: charged.charge_pence,
    intervals_charged: charged.intervals_charged,
    interval_seconds: charged.interval_seconds,
    paid_seconds: charged.paid_seconds_capped,
    rate_pence_per_minute: config.pickup_paid_waiting_rate_pence_per_minute,
  });

  return {
    pickup_waiting_charge_pence: charged.charge_pence,
    intervals_charged: charged.intervals_charged,
    already_finalized: false,
  };
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
  driver_id?: string | null;
  arrived_at?: string | null;
  pickup_arrived_at?: string | null;
  driver_arrived_at?: string | null;
  pickup_waiting_started_at?: string | null;
  pickup_waiting_admin_config?: unknown;
  free_wait_expires_at?: string | null;
  pickup_waiting_finalized_at?: string | null;
  pickup_waiting_intervals_charged?: number | null;
  stop_arrived_at?: string | null;
  pickup_paid_waiting_started_at?: string | null;
  pickup_waiting_charge_pence?: number | null;
  grace_period_expired_at?: string | null;
  stop_waiting_paid_started_at?: string | null;
  stop_waiting_charge_pence?: number | null;
  stop_waiting_status?: string | null;
  total_waiting_charge_pence?: number | null;
};

/** Merge stub re-select with original trip so SA / vehicle SSOT is never dropped. */
function mergeTripWaitingCtx(
  original: TripWaitingBillingCtx,
  stub: TripWaitingBillingCtx | null | undefined,
): TripWaitingBillingCtx {
  return {
    ...original,
    ...(stub ?? {}),
    service_area_id: stub?.service_area_id ?? original.service_area_id ?? null,
    vehicle_type_id: stub?.vehicle_type_id ?? original.vehicle_type_id ?? null,
    pickup_waiting_started_at:
      stub?.pickup_waiting_started_at ?? original.pickup_waiting_started_at ?? null,
    pickup_waiting_admin_config:
      stub?.pickup_waiting_admin_config ?? original.pickup_waiting_admin_config ?? null,
    free_wait_expires_at: stub?.free_wait_expires_at ?? original.free_wait_expires_at ?? null,
    arrived_at: stub?.arrived_at ?? original.arrived_at ?? null,
    pickup_arrived_at: stub?.pickup_arrived_at ?? original.pickup_arrived_at ?? null,
  };
}

const ARRIVE_WAITING_TRIP_SELECT =
  "id, status, arrived_at, pickup_arrived_at, pickup_waiting_started_at, pickup_waiting_admin_config, free_wait_expires_at, pickup_waiting_charge_pence, pickup_paid_waiting_started_at, pickup_waiting_finalized_at, pickup_waiting_intervals_charged, service_area_id, vehicle_type_id, driver_id, updated_at";

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
  const liveConfig = await loadAdminWaitingConfig(
    supabase,
    ctx.trip.service_area_id ?? null,
    ctx.trip.vehicle_type_id ?? null,
  );

  // Prefer already-frozen trip snapshot; do not re-poison from live Admin on idempotent Arrived.
  const existingFrozen = ctx.trip.pickup_waiting_admin_config;
  const config: AdminWaitingConfigSnapshot =
    ctx.scope === "pickup" && existingFrozen
      ? resolveFrozenOrLiveWaitingConfig(existingFrozen, liveConfig)
      : liveConfig;

  if (ctx.scope === "pickup" && ctx.trip_id) {
    const waitingAnchorIso =
      typeof ctx.trip.pickup_waiting_started_at === "string" &&
        ctx.trip.pickup_waiting_started_at.trim()
        ? ctx.trip.pickup_waiting_started_at
        : null;
    const freeWaitExpiresAt =
      waitingAnchorIso != null
        ? new Date(
          new Date(waitingAnchorIso).getTime() +
            config.free_pickup_waiting_seconds * 1000,
        ).toISOString()
        : null;

    const existingObj =
      existingFrozen && typeof existingFrozen === "object" && !Array.isArray(existingFrozen)
        ? (existingFrozen as Record<string, unknown>)
        : {};
    const alreadyFareFrozen = existingObj.pickup_grace_source === "fare_pricing";

    // Always MERGE provenance; never replace a good freeze with a bare snapshot
    // that strips waiting_context / driver_id / frozen_at.
    const frozenConfig: Record<string, unknown> = alreadyFareFrozen
      ? {
        ...existingObj,
        waiting_context: existingObj.waiting_context ?? "pickup",
        driver_id: existingObj.driver_id ?? ctx.trip.driver_id ?? null,
        service_area_id: existingObj.service_area_id ?? ctx.trip.service_area_id ?? null,
        vehicle_type_id: existingObj.vehicle_type_id ?? ctx.trip.vehicle_type_id ?? null,
        trip_id: existingObj.trip_id ?? ctx.trip_id,
        frozen_at: existingObj.frozen_at ?? new Date().toISOString(),
      }
      : {
        ...existingObj,
        ...config,
        waiting_context: "pickup",
        driver_id: ctx.trip.driver_id ?? null,
        service_area_id: ctx.trip.service_area_id ?? null,
        vehicle_type_id: ctx.trip.vehicle_type_id ?? null,
        trip_id: ctx.trip_id,
        frozen_at: new Date().toISOString(),
      };

    const { error: cfgErr } = await updateTripSafe(supabase, ctx.trip_id, {
      pickup_waiting_admin_config: frozenConfig,
      ...(freeWaitExpiresAt && !ctx.trip.free_wait_expires_at
        ? { free_wait_expires_at: freeWaitExpiresAt }
        : freeWaitExpiresAt && !alreadyFareFrozen
        ? { free_wait_expires_at: freeWaitExpiresAt }
        : {}),
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
        free_wait_expires_at: freeWaitExpiresAt,
        pickup_grace_source: config.pickup_grace_source,
        pickup_paid_waiting_enabled: config.pickup_paid_waiting_enabled,
        waiting_charge_interval_seconds: config.waiting_charge_interval_seconds,
        pickup_paid_waiting_rate_pence_per_minute:
          config.pickup_paid_waiting_rate_pence_per_minute,
        waiting_context: "pickup",
        driver_id: ctx.trip.driver_id ?? null,
        service_area_id: ctx.trip.service_area_id ?? null,
        vehicle_type_id: ctx.trip.vehicle_type_id ?? null,
        config_available: config.config_available,
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
  const waitingStartedAt =
    typeof ctx.trip.pickup_waiting_started_at === "string" &&
      ctx.trip.pickup_waiting_started_at.trim()
      ? ctx.trip.pickup_waiting_started_at
      : null;
  const pickupWaitingStatus =
    ctx.scope === "pickup"
      ? resolveWaitingStatusFromResult(waitingResult)
      : waitingStartedAt
        ? "free_waiting"
        : "not_started";
  // Timer/free-wait projection must anchor to pickup_waiting_started_at only.
  const pickupSnapshot = buildPickupWaitingSnapshot({
    driverArrivedAt: waitingStartedAt,
    waitingStatus: waitingStartedAt ? pickupWaitingStatus : "not_started",
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

  const freeWaitExpiresAt =
    waitingStartedAt != null
      ? (ctx.trip.free_wait_expires_at ?? pickupSnapshot.pickup_waiting_free_expires_at)
      : null;

  return {
    ...radiusFields,
    ...billing,
    driver_arrived_at: driverArrivedAt,
    pickup_arrived_at: driverArrivedAt,
    pickup_waiting_started_at: waitingStartedAt,
    free_wait_expires_at: freeWaitExpiresAt,
    pickup_waiting_state: pickupSnapshot.pickup_waiting_state,
    pickup_waiting_free_expires_at: freeWaitExpiresAt,
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
  start_error?: string;
};

type StopWaitingStartResult = {
  started: boolean;
  waiting_status: 'not_started' | 'blocked_outside_radius' | 'free_waiting';
  graceSeconds: number;
  allowed_radius_meters?: number | null;
  distance_meters?: number | null;
};

/**
 * P0 #2: successful Arrived always starts exactly one pickup waiting instance.
 * Radius may still be reported for UI / paid-charge enforcement in tick,
 * but pickup_waiting_started_at must not remain NULL after Arrived.
 */
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

  let outsideRadius = false;
  let distanceM: number | null = null;
  let allowedRadius: number | null = radiusMeters;

  if (radiusEnabled) {
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
      outsideRadius = true;
      distanceM =
        check.current_distance_meters >= 0 ? check.current_distance_meters : null;
      allowedRadius = check.required_radius_meters;
      console.log('[stop-workflow] WAITING_RADIUS_CHECK_OUTSIDE', {
        trip_id: tripId,
        scope: 'pickup',
        distance_meters: distanceM,
        allowed_radius_meters: allowedRadius,
        note: 'waiting_still_starts_on_arrived',
      });
    } else {
      console.log('[stop-workflow] WAITING_RADIUS_CHECK_INSIDE', { trip_id: tripId, scope: 'pickup' });
    }
  } else {
    console.log('[stop-workflow] WAITING_RADIUS_CHECK_STARTED', {
      trip_id: tripId,
      scope: 'pickup',
      radius_enforced: false,
    });
  }

  const anchor = trip.arrived_at || pickupStop?.arrived_at || now;
  const startResult = await ensurePickupWaitingStarted(
    supabase,
    tripId,
    { ...trip, arrived_at: anchor },
    pickupStop,
    now,
  );
  if (!startResult.ok) {
    return {
      started: false,
      waiting_status: 'not_started',
      allowed_radius_meters: allowedRadius,
      distance_meters: distanceM,
      start_error: startResult.error,
    };
  }

  if (outsideRadius) {
    return {
      started: true,
      waiting_status: 'free_waiting',
      allowed_radius_meters: allowedRadius,
      distance_meters: distanceM,
    };
  }
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
    // P0 #2: when SA is known, NEVER poison from global dispatch (300s / paid false / 10s).
  } else {
    const { data } = await supabase
      .from('dispatch_settings')
      .select(dispatchCols)
      .is('service_area_id', null)
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
  }

  if (!merged._stop_radius_source && typeof merged.stop_radius_meters === 'number') {
    merged._stop_radius_source = 'dispatch_settings';
  }

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
    const { trip_id, driver_id: requestedDriverId, action, driver_lat, driver_lng, cancel_reason } = body;

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
              "id, status, dispatch_status, arrived_at, pickup_arrived_at, started_at, completed_at, current_stop_index, current_stop_id, pickup_waiting_started_at, pickup_paid_waiting_started_at, pickup_waiting_charge_pence, pickup_waiting_admin_config, free_wait_expires_at, pickup_waiting_finalized_at, pickup_waiting_intervals_charged, stop_waiting_charge_pence, stop_charge_total_pence, final_fare_pence, final_customer_fare_pence, locked_base_fare_pence, driver_id, payment_status, payment_method, updated_at",
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

    // Fetch trip — explicit columns only (retired scan_go / locked_driver_id must never be selected).
    const { data: trip, error: tripError } = await supabase
      .from("trips")
      .select(
        "id, status, dispatch_status, dispatch_mode, service_area_id, vehicle_type_id, region_id, passenger_id, driver_id, confirmed_driver_id, previous_driver_id, pickup_address, dropoff_address, pickup_latitude, pickup_longitude, dropoff_latitude, dropoff_longitude, arrived_at, pickup_arrived_at, started_at, completed_at, cancelled_at, current_stop_index, current_stop_id, pickup_waiting_started_at, pickup_paid_waiting_started_at, pickup_waiting_charge_pence, pickup_waiting_admin_config, free_wait_expires_at, pickup_waiting_finalized_at, pickup_waiting_intervals_charged, stop_waiting_charge_pence, stop_charge_total_pence, stop_arrived_at, stop_waiting_started_at, final_fare_pence, final_customer_fare_pence, locked_base_fare_pence, payment_status, payment_method, scheduled_at, airport_charge_pence, driver_started_journey_to_pickup_at, special_instructions, stacked_trip_id, tip_window_expires_at, tip_window_closed_at, updated_at",
      )
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

        if (!scheduledAt) {
          return errorResponse(
            "invalid_trip_type",
            "Start journey to pickup is only available for prebooked trips",
            409,
          );
        }

        if (airportChargePence <= 0) {
          return errorResponse(
            "invalid_trip_type",
            "Start journey to pickup is only available for airport trips",
            409,
          );
        }

        if (trip.arrived_at || ARRIVED_AT_PICKUP_STATUSES.has(String(trip.status || '').toLowerCase())) {
          return errorResponse(
            "invalid_status",
            "Cannot start journey after arriving at pickup",
            409,
          );
        }

        if (existingStartedAt) {
          console.log("[stop-workflow] DRIVER_STARTED_JOURNEY_TO_PICKUP", {
            trip_id,
            driver_id,
            idempotent: true,
            driver_started_journey_to_pickup_at: existingStartedAt,
          });
          return await respondOk({
            success: true,
            idempotent: true,
            action: 'start_journey_to_pickup',
            driver_started_journey_to_pickup_at: existingStartedAt,
          });
        }

        const { error: journeyUpdateError } = await updateTripSafe(supabase, trip_id, {
          driver_started_journey_to_pickup_at: nowIso,
          updated_at: nowIso,
        });

        if (journeyUpdateError) {
          console.error("[stop-workflow] start_journey_to_pickup failed:", journeyUpdateError);
          return errorResponse("rpc_error", "Failed to record journey start", 500, journeyUpdateError);
        }

        console.log("[stop-workflow] DRIVER_STARTED_JOURNEY_TO_PICKUP", {
          trip_id,
          driver_id,
          driver_started_journey_to_pickup_at: nowIso,
        });
        console.log("[stop-workflow] AIRPORT_PROTECTION_ACTIVATED", {
          trip_id,
          driver_id,
          airport_charge_pence: airportChargePence,
          scheduled_at: scheduledAt,
        });

        return await respondOk({
          success: true,
          action: 'start_journey_to_pickup',
          driver_started_journey_to_pickup_at: nowIso,
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

        // Idempotent: stop and trip both reflect arrival — ensure waiting started once
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
          if (waitingResult.start_error) {
            return errorResponse(
              "PICKUP_WAITING_START_FAILED",
              waitingResult.start_error,
              500,
            );
          }
          const { data: syncedTrip } = await supabase
            .from("trips")
            .select(ARRIVE_WAITING_TRIP_SELECT)
            .eq("id", trip_id)
            .single();
          const billingTrip = mergeTripWaitingCtx(trip, syncedTrip as TripWaitingBillingCtx | null);
          if (!billingTrip.pickup_waiting_started_at) {
            return errorResponse(
              "PICKUP_WAITING_START_FAILED",
              "pickup_waiting_started_at missing after Arrived",
              500,
            );
          }
          console.log("[stop-workflow] ARRIVED_RPC_RESPONSE", {
            trip_id,
            idempotent: true,
            trip_status: trip.status,
            waiting_started: waitingResult.started,
            waiting_status: waitingResult.waiting_status,
            pickup_waiting_started_at: billingTrip.pickup_waiting_started_at ?? null,
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
              pickup_waiting_started_at: billingTrip.pickup_waiting_started_at,
            },
          }, waitingResult, { scope: 'pickup', trip: billingTrip, trip_id }));
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
          if (waitingResult.start_error) {
            return errorResponse(
              "PICKUP_WAITING_START_FAILED",
              waitingResult.start_error,
              500,
            );
          }

          const { data: syncedTrip } = await supabase
            .from("trips")
            .select(ARRIVE_WAITING_TRIP_SELECT)
            .eq("id", trip_id)
            .single();
          const billingTrip = mergeTripWaitingCtx(
            { ...trip, arrived_at: arrivedAnchor, pickup_arrived_at: arrivedAnchor },
            syncedTrip as TripWaitingBillingCtx | null,
          );
          if (!billingTrip.pickup_waiting_started_at) {
            return errorResponse(
              "PICKUP_WAITING_START_FAILED",
              "pickup_waiting_started_at missing after Arrived",
              500,
            );
          }

          console.log("[stop-workflow] ARRIVED_RPC_RESPONSE", {
            trip_id,
            idempotent: true,
            synced_trip_status: true,
            waiting_started: waitingResult.started,
            waiting_status: waitingResult.waiting_status,
            pickup_waiting_started_at: billingTrip.pickup_waiting_started_at ?? null,
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
          }, waitingResult, { scope: 'pickup', trip: billingTrip, trip_id }));
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
        if (waitingResult.start_error) {
          return errorResponse(
            "PICKUP_WAITING_START_FAILED",
            waitingResult.start_error,
            500,
          );
        }

        const { data: updatedTrip } = await supabase
          .from("trips")
          .select(ARRIVE_WAITING_TRIP_SELECT)
          .eq("id", trip_id)
          .single();
        const billingTrip = mergeTripWaitingCtx(
          { ...trip, arrived_at: now, pickup_arrived_at: now },
          updatedTrip as TripWaitingBillingCtx | null,
        );
        if (!billingTrip.pickup_waiting_started_at) {
          return errorResponse(
            "PICKUP_WAITING_START_FAILED",
            "pickup_waiting_started_at missing after Arrived",
            500,
          );
        }

        console.log("[stop-workflow] ARRIVED_RPC_RESPONSE", {
          trip_id,
          driver_id,
          trip_status: updatedTrip?.status,
          waiting_started: waitingResult.started,
          waiting_status: waitingResult.waiting_status,
          pickup_waiting_started_at: billingTrip.pickup_waiting_started_at ?? null,
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
              pickup_waiting_started_at: billingTrip.pickup_waiting_started_at ?? null,
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
        }, waitingResult, { scope: 'pickup', trip: billingTrip, trip_id }));
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
          await updateTripSafe(supabase, trip_id, {
            status: CANONICAL_ARRIVED_STATUS,
            arrived_at: now,
            pickup_arrived_at: now,
            updated_at: now,
          });
          pickupStop.status = 'current';
          pickupStop.arrived_at = now;
          // P0 #2: auto-arrive must still create the pickup waiting instance.
          const autoWait = await ensurePickupWaitingStarted(
            supabase,
            trip_id,
            {
              arrived_at: now,
              pickup_waiting_started_at: trip.pickup_waiting_started_at ?? null,
            },
            pickupStop,
            now,
          );
          if (autoWait.ok) {
            trip.pickup_waiting_started_at = autoWait.startedAt;
            trip.arrived_at = now;
            trip.pickup_arrived_at = now;
          } else {
            console.error("[stop-workflow] AUTO_ARRIVE_WAITING_START_FAILED", {
              trip_id,
              error: autoWait.error,
            });
          }
        }

        // Idempotency: already started — waiting already frozen on first start
        if (trip.started_at) {
          console.log("[stop-workflow] Trip already started (idempotent)");
          return await respondOk({
            success: true,
            idempotent: true,
            message: "Trip already started",
            pickup_waiting_charge_pence: trip.pickup_waiting_charge_pence ?? 0,
            pickup_waiting_finalized_at: trip.pickup_waiting_finalized_at ?? null,
          });
        }

        const waitingFinal = await finalizePickupWaitingOnStartTrip(
          supabase,
          trip as TripWaitingBillingCtx,
          trip_id,
          now,
        );

        if (!waitingFinal.already_finalized) {
          await writeTripAudit(supabase, {
            trip_id,
            driver_id,
            event_type: 'PICKUP_WAITING_FINALIZED',
            details: {
              pickup_waiting_charge_pence: waitingFinal.pickup_waiting_charge_pence,
              intervals_charged: waitingFinal.intervals_charged,
            },
          });
          if (waitingFinal.pickup_waiting_charge_pence > 0) {
            await writeFareAudit(supabase, {
              trip_id,
              event_type: 'PICKUP_WAITING_CHARGE_ADDED_TO_FARE',
              adjustment_pence: waitingFinal.pickup_waiting_charge_pence,
              metadata: {
                intervals_charged: waitingFinal.intervals_charged,
                source: 'start_trip',
              },
            });
          }
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

        console.log("[stop-workflow] START_TRIP success, next stop:", nextStop?.stop_index || 'none', {
          pickup_waiting_charge_pence: waitingFinal.pickup_waiting_charge_pence,
          intervals_charged: waitingFinal.intervals_charged,
          already_finalized: waitingFinal.already_finalized,
        });
        await writeTripAudit(supabase, {
          trip_id,
          driver_id,
          event_type: 'START_TRIP_TAPPED',
          details: {
            next_stop_index: nextStop?.stop_index ?? null,
            pickup_waiting_charge_pence: waitingFinal.pickup_waiting_charge_pence,
            pickup_waiting_intervals_charged: waitingFinal.intervals_charged,
          },
        });
        return await respondOk({
          success: true,
          action: 'start_trip',
          next_stop_index: nextStop?.stop_index || null,
          pickup_waiting_charge_pence: waitingFinal.pickup_waiting_charge_pence,
          pickup_waiting_intervals_charged: waitingFinal.intervals_charged,
        });
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
          getDriverCommissionPct(supabase, driver_id, (tripBeforeComplete ?? trip).service_area_id),
          supabase
            .from('drivers')
            .select('region_id, total_trips, regions(currency_code)')
            .eq('id', driver_id)
            .single(),
        ]);

        // Queued stacked trips may exist even if stacked_trip_id link was cleared (max 2–3).
        const { count: remainingQueuedCount } = await supabase
          .from("trips")
          .select("id", { count: "exact", head: true })
          .eq("status", "queued")
          .or(`driver_id.eq.${driver_id},confirmed_driver_id.eq.${driver_id}`);
        const hasStackedTrip =
          trip.stacked_trip_id != null || (remainingQueuedCount ?? 0) > 0;

        if (!hasStackedTrip) {
          // No stacked trip — clear current_trip_id (fire-and-forget is fine here)
          await supabase
            .from("drivers")
            .update({ current_trip_id: null, updated_at: now })
            .eq("id", driver_id);
        } else {
          console.log(
            "[stop-workflow] Stacked queue present:",
            {
              stacked_trip_id: trip.stacked_trip_id,
              remaining_queued: remainingQueuedCount ?? 0,
            },
            "- keeping current_trip_id for post-trip promotion",
          );
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

        const commissionPct = Number(commissionResult);
        const tipAmountPence = fareTrip.tip_amount_pence || fareTrip.tip_pence || 0;
        const isCash = (fareTrip.payment_method ?? "").toLowerCase() === "cash";
        const isOperationalCash = isCash && Boolean(fareTrip.cash_authorized_at);
        // EXISTING CODE REPAIRED — Revolut Payment Session / provider_order_id gate (never Stripe PI).
        const needsProviderSettlement = requiresProviderSettlement(fareTrip);
        const providerOrderId = tripProviderOrderId(fareTrip);
        const isCardPaymentMethodFlag = isCardPaymentMethod(fareTrip.payment_method);

        // Settle from fare row with waiting forced in — never ride-only final_customer.
        const settlementRow = buildSettlementTripRow({
          trip: {
            ...fareTrip,
            airport_charge_pence: resolvedFare.airport_charge_pence,
            accepted_commission_percent: fareTrip.accepted_commission_percent,
            driver_tier_commission_percent: resolveTripTierPercent({
              ...fareTrip,
              commission_pct: fareTrip.commission_pct ?? commissionPct,
            }),
            commission_pct: fareTrip.commission_pct ?? commissionPct,
          },
          finalFarePence,
          tipPence: tipAmountPence,
          pickupWaitingChargePence: resolvedFare.arrival_waiting_charge_pence,
          stopWaitingChargePence: resolvedFare.stop_waiting_charge_pence,
        });
        const settlement = calculateTripSettlementFromTripRow(settlementRow);
        if (!settlement) {
          return errorResponse("SETTLEMENT_FAILED", "Unable to compute trip settlement", 500);
        }
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
          needsProviderSettlement,
          provider_order_id: providerOrderId,
          payment_provider: fareTrip.payment_provider ?? null,
          ledgerCurrency,
        }));

        // Increment driver's total_trips (parallel with ledger work)
        const currentTotalTrips = driverRegionResult?.data?.total_trips || 0;
        const tripIncrementPromise = supabase
          .from("drivers")
          .update({ total_trips: currentTotalTrips + 1 })
          .eq("id", driver_id);

        // P0: Revolut card / Apple Pay / Google Pay — capture via existing finalize-trip-and-capture.
        // Driver wallet must NOT be credited here before provider-confirmed capture.
        // Persist settlement columns BEFORE finalize so applyCanonicalSettlementAfterCapture
        // can credit TRIP_EARNING_NET from trips.driver_net_pence (existing SSOT).
        if (needsProviderSettlement) {
          await supabase.from("trips").update({
            ...tripSettlementDbColumns(settlement),
            tip_amount_pence: tipAmountPence,
            tip_pence: tipAmountPence,
            final_fare_pence: finalFarePence,
            final_customer_fare_pence:
              nonNegInt(fareTrip.final_customer_fare_pence) || finalFarePence,
            updated_at: new Date().toISOString(),
          }).eq("id", trip_id);

          const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
          const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
          console.log("[PAYMENT_AUDIT]", JSON.stringify({
            stage: "auto_capture_trigger",
            trip_id,
            provider_order_id: providerOrderId,
            payment_session_id: fareTrip.payment_session_id ?? null,
            source: "stop-workflow:complete_trip",
            driver_net_pence: settlement.driver_net_pence,
          }));
          let finalizeResult: { ok: boolean; error?: string; body?: Record<string, unknown> };
          try {
            finalizeResult = await invokeFinalizeTripCapture(
              supabaseUrl,
              serviceRoleKey,
              trip_id,
              0,
            );
          } catch (finalizeErr) {
            finalizeResult = {
              ok: false,
              error: finalizeErr instanceof Error
                ? finalizeErr.message
                : String(finalizeErr),
            };
          }
          if (!finalizeResult.ok) {
            console.error("[stop-workflow] finalize-trip-and-capture failed:", finalizeResult.error);
            const bodyStatus = String(
              (finalizeResult.body as { status?: string } | undefined)?.status ?? "",
            ).toLowerCase();
            const bodyOkFlag = (finalizeResult.body as { success?: boolean } | undefined)?.success;
            // Durable shortfall/recovery/incremental outcomes must NOT be clobbered to capture_failed.
            const isDurableRecovery =
              bodyStatus.includes("shortfall") ||
              bodyStatus.includes("recovery") ||
              bodyStatus.includes("partial_capture") ||
              bodyStatus.includes("additional_authorisation") ||
              bodyStatus.includes("incremental");

            const { data: freshPay } = await supabase
              .from("trips")
              .select("payment_status, payment_hold_status")
              .eq("id", trip_id)
              .maybeSingle();
            const freshStatus = String(freshPay?.payment_status ?? "").toLowerCase();
            const freshHold = String(freshPay?.payment_hold_status ?? "").toLowerCase();
            const alreadyShortfall =
              freshStatus === "payment_shortfall" ||
              freshHold.includes("shortfall") ||
              freshHold.includes("recovery");

            if (isDurableRecovery || alreadyShortfall || bodyOkFlag === true) {
              const hold = isDurableRecovery
                ? (bodyStatus.includes("additional_authorisation") || bodyStatus.includes("incremental")
                  ? (bodyStatus.includes("fail")
                    ? "incremental_authorisation_failed"
                    : "incremental_authorisation_pending")
                  : (bodyStatus || "payment_shortfall"))
                : (freshHold || "payment_shortfall");
              await supabase.from("trips").update({
                payment_status: alreadyShortfall || bodyStatus.includes("shortfall") ||
                    bodyStatus.includes("recovery") || bodyStatus.includes("partial_capture")
                  ? "payment_shortfall"
                  : (bodyStatus.includes("fail") ? "capture_failed" : "authorized"),
                payment_hold_status: hold,
                updated_at: new Date().toISOString(),
              }).eq("id", trip_id);
            } else {
              await recordTripCaptureFailure(
                supabase,
                trip_id,
                finalizeResult.error ?? "Auto capture failed",
                providerOrderId,
              );
              // Durable settlement outcome — never leave authorized+draft after complete.
              await supabase.from("trips").update({
                payment_status: "capture_failed",
                payment_hold_status: "capture_failed",
                updated_at: new Date().toISOString(),
              }).eq("id", trip_id);
              if (hasStackedTrip) {
                await handleQueuedTripAfterPaymentFailure(supabase, {
                  currentTripId: trip_id,
                  driverId: driver_id,
                  paymentStatus: "capture_failed",
                });
              }
            }
          } else {
            console.log("[stop-workflow] finalize-trip-and-capture invoked", finalizeResult.body);
            const bodyStatus = String(
              (finalizeResult.body as { status?: string } | undefined)?.status ?? "",
            ).toLowerCase();
            if (
              bodyStatus.includes("shortfall") ||
              bodyStatus.includes("recovery") ||
              bodyStatus.includes("additional_authorisation") ||
              bodyStatus.includes("incremental") ||
              bodyStatus.includes("partial_capture")
            ) {
              const colsStatus = bodyStatus.includes("shortfall") ||
                  bodyStatus.includes("recovery") ||
                  bodyStatus.includes("partial_capture")
                ? "payment_shortfall"
                : bodyStatus.includes("fail")
                ? "capture_failed"
                : "authorized";
              await supabase.from("trips").update({
                payment_status: colsStatus,
                payment_hold_status: bodyStatus.includes("additional_authorisation") ||
                    bodyStatus.includes("incremental")
                  ? (bodyStatus.includes("fail")
                    ? "incremental_authorisation_failed"
                    : "incremental_authorisation_pending")
                  : bodyStatus,
                updated_at: new Date().toISOString(),
              }).eq("id", trip_id);
            }
          }
        } else if (isCardPaymentMethodFlag && !needsProviderSettlement) {
          // Card trip without usable provider order/session — persist explicit failure.
          console.error("[stop-workflow] card trip missing provider settlement identity", {
            trip_id,
            payment_method: fareTrip.payment_method,
            payment_provider: fareTrip.payment_provider ?? null,
            payment_session_id: fareTrip.payment_session_id ?? null,
          });
          await supabase.from("trips").update({
            payment_status: "capture_failed",
            payment_hold_status: "provider_authorisation_missing",
            updated_at: new Date().toISOString(),
          }).eq("id", trip_id);
        }

        const skipCardLedgerInStopWorkflow = needsProviderSettlement;
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
                amount_pence: driverNetBeforeTip + settlement.airport_charge_pence,
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
        // RPC falls back to stack_position when stacked_trip_id is null (Admin max 2–3).
        if (hasStackedTrip) {
          const promotion = await tryPromoteStackedTripAfterCompletion(
            supabase,
            driver_id,
            trip_id,
          );
          console.log("[stop-workflow] STACKED_TRIP_PROMOTION_AFTER_COMPLETE", {
            completed_trip_id: trip_id,
            stacked_trip_id: trip.stacked_trip_id,
            remaining_queued: remainingQueuedCount ?? 0,
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
