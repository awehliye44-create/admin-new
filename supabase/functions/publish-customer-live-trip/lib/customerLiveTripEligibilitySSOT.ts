/**
 * Customer Live Trip eligibility — presentation gate only.
 * Future scheduled commitments must NEVER create/start a Live Activity merely
 * because status is accepted / assigned / confirmed / scheduled_committed.
 *
 * Reuses restore-active-trip scheduled window semantics. Does not change
 * activation timing, dispatch, or trip status writers.
 */

export type LiveTripEligibilityInput = {
  status?: unknown;
  dispatch_status?: unknown;
  dispatchStatus?: unknown;
  booking_type?: unknown;
  trip_type?: unknown;
  is_scheduled?: unknown;
  scheduled_status?: unknown;
  scheduledStatus?: unknown;
  dispatch_mode?: unknown;
  dispatchMode?: unknown;
  scheduled_at?: unknown;
  scheduledAt?: unknown;
  scheduled_broadcast_at?: unknown;
  scheduled_convert_at?: unknown;
  confirmed_driver_id?: unknown;
  confirmedDriverId?: unknown;
  driver_id?: unknown;
  /** Wall clock for window checks. */
  nowMs?: number;
};

const TERMINAL = new Set([
  "completed",
  "complete",
  "finished",
  "cancelled",
  "canceled",
  "customer_cancelled",
  "customer_canceled",
  "passenger_cancelled",
  "passenger_canceled",
  "cancelled_by_admin",
  "canceled_by_admin",
  "admin_cancelled",
  "admin_canceled",
  "expired",
  "expired_no_driver",
  "no_driver",
  "no_driver_found",
  "no_drivers_available",
  "no_show",
  "failed",
  "declined",
  "rejected",
  "refunded",
  "released",
]);

const SEARCHING_ACTIVE = new Set([
  "pending",
  "searching",
  "searching_for_driver",
  "offered",
  "offering",
  "broadcasting",
  "dispatching",
  "negotiating",
  "payment_pending",
  "searching_new_driver",
  "rematching",
  "driver_cancelled",
  "driver_canceled",
  "driver_assignment_cancelled",
  "driver_assignment_canceled",
]);

const LIVE_JOURNEY = new Set([
  "driver_assigned",
  "assigned",
  "accepted",
  "confirmed",
  "driver_confirmed",
  "queued",
  "en_route",
  "en_route_to_pickup",
  "enroute_to_pickup",
  "driver_en_route",
  "driver_arriving",
  "arrived",
  "arrived_pickup",
  "arrived_at_pickup",
  "at_pickup",
  "pickup_waiting",
  "waiting",
  "waiting_at_pickup",
  "driver_arrived",
  "in_progress",
  "started",
  "trip_started",
  "on_trip",
  "en_route_to_dropoff",
  "enroute_to_dropoff",
  "passenger_onboard",
  "ongoing",
  "completing",
  "en_route_to_stop",
  "arrived_at_stop",
  "at_stop",
  "waiting_at_stop",
  "arrived_at_destination",
  "arrived_destination",
  "at_destination",
]);

/** Pre-activation scheduled holds — never Live Trip eligible on these alone. */
const SCHEDULED_HOLD_STATUSES = new Set([
  "scheduled",
  "scheduled_committed",
]);

const SCHEDULED_HOLD_SCHEDULED_STATUS = new Set([
  "admin_held",
  "awaiting_activation_accept",
  "driver_assigned",
  "scheduled_committed",
  "accepted",
  "confirmed",
  "pending_assignment",
  "pending_departure_ack",
  "awaiting_departure_ack",
  "marketplace_accepted",
  "legacy_accepted",
]);

export function normalizeLiveTripStatus(raw: unknown): string {
  return typeof raw === "string"
    ? raw.trim().toLowerCase().replace(/-/g, "_")
    : "";
}

function readBool(raw: unknown): boolean {
  return raw === true;
}

function isScheduledOrigin(input: LiveTripEligibilityInput): boolean {
  const bookingType = normalizeLiveTripStatus(input.booking_type ?? input.trip_type);
  if (bookingType === "instant" || bookingType === "immediate") return false;
  if (bookingType === "scheduled") return true;
  if (readBool(input.is_scheduled)) return true;
  const mode = normalizeLiveTripStatus(input.dispatch_mode ?? input.dispatchMode);
  if (mode === "scheduled") return true;
  const scheduledStatus = normalizeLiveTripStatus(
    input.scheduled_status ?? input.scheduledStatus,
  );
  if (scheduledStatus.length > 0) return true;
  const scheduledAt = input.scheduled_at ?? input.scheduledAt;
  return typeof scheduledAt === "string" && scheduledAt.trim().length > 0;
}

function scheduledDispatchWindowReached(
  input: LiveTripEligibilityInput,
  nowMs: number,
): boolean {
  const dispatchMode = normalizeLiveTripStatus(input.dispatch_mode ?? input.dispatchMode);
  if (dispatchMode === "instant") return true;

  const scheduledStatus = normalizeLiveTripStatus(
    input.scheduled_status ?? input.scheduledStatus,
  );
  if (SCHEDULED_HOLD_SCHEDULED_STATUS.has(scheduledStatus)) {
    return false;
  }

  for (const key of [
    "scheduled_broadcast_at",
    "scheduled_convert_at",
    "scheduled_at",
    "scheduledAt",
  ] as const) {
    const raw = (input as Record<string, unknown>)[key];
    if (typeof raw === "string" && raw.trim()) {
      const ms = Date.parse(raw);
      if (Number.isFinite(ms) && ms <= nowMs) return true;
    }
  }
  return false;
}

function hasAssignedDriver(input: LiveTripEligibilityInput): boolean {
  for (const value of [
    input.confirmed_driver_id,
    input.confirmedDriverId,
    input.driver_id,
  ]) {
    if (typeof value === "string" && value.trim()) return true;
  }
  return false;
}

export type LiveTripEligibilityResult = {
  eligible: boolean;
  reason: string;
  terminal: boolean;
};

/**
 * True only for genuine customer-visible active searching or active journey.
 * Presentation-only — never starts Live Trip for future scheduled commitments.
 */
export function resolveCustomerLiveTripEligibility(
  input: LiveTripEligibilityInput,
): LiveTripEligibilityResult {
  const nowMs =
    typeof input.nowMs === "number" && Number.isFinite(input.nowMs)
      ? input.nowMs
      : Date.now();
  const status = normalizeLiveTripStatus(input.status);
  const dispatchStatus = normalizeLiveTripStatus(
    input.dispatch_status ?? input.dispatchStatus,
  );

  if (!status && !dispatchStatus) {
    return { eligible: false, reason: "missing_status", terminal: false };
  }

  if (TERMINAL.has(status) || TERMINAL.has(dispatchStatus)) {
    return { eligible: false, reason: "terminal", terminal: true };
  }

  if (SCHEDULED_HOLD_STATUSES.has(status)) {
    return { eligible: false, reason: "scheduled_hold_status", terminal: false };
  }

  const scheduledOrigin = isScheduledOrigin(input);
  if (scheduledOrigin && !scheduledDispatchWindowReached(input, nowMs)) {
    // Marketplace / legacy / admin assign / pending ack before activation window.
    return {
      eligible: false,
      reason: "scheduled_pre_activation",
      terminal: false,
    };
  }

  // After scheduled→instant conversion / window reached: searching or journey OK.
  if (SEARCHING_ACTIVE.has(status) || SEARCHING_ACTIVE.has(dispatchStatus)) {
    if (scheduledOrigin && !scheduledDispatchWindowReached(input, nowMs)) {
      return { eligible: false, reason: "scheduled_search_pre_window", terminal: false };
    }
    return { eligible: true, reason: "active_searching", terminal: false };
  }

  if (LIVE_JOURNEY.has(status) || LIVE_JOURNEY.has(dispatchStatus)) {
    if (scheduledOrigin && !scheduledDispatchWindowReached(input, nowMs)) {
      // assigned/confirmed on a future scheduled commitment — not live yet.
      return {
        eligible: false,
        reason: "scheduled_assigned_pre_activation",
        terminal: false,
      };
    }
    // Bare accepted/confirmed without driver on non-scheduled can still be search-adjacent;
    // require driver id for "assigned" presentation eligibility when not searching.
    if (
      (status === "accepted" || status === "confirmed") &&
      !hasAssignedDriver(input) &&
      !SEARCHING_ACTIVE.has(dispatchStatus)
    ) {
      return { eligible: false, reason: "accepted_without_assignment", terminal: false };
    }
    return { eligible: true, reason: "active_journey", terminal: false };
  }

  return { eligible: false, reason: "not_live_lifecycle", terminal: false };
}
