/**
 * Scheduled dispatch config — global_dispatch_settings SSOT.
 * Admin Auto-Dispatch Rules UI writes this table; scheduled-dispatch reads it.
 */

export type ScheduledDispatchConfig = {
  enableScheduledToUrgentConversion: boolean;
  responseWindowMinutes: number;
  urgentTriggerMinutesBeforePickup: number;
  lockedDriverResponseMinutes: number;
  maxFindDriverMinutes: number;
  scheduledUrgentCardLabel: string;
  // Commitment mode (ETA-based activation — no second accept)
  targetArrivalMinutesBeforePickup: number;   // driver must arrive this many min early (default 5)
  notMovingAlertAfterSeconds: number;         // alert if driver hasn't moved for this long (default 60)
  movingAwayThresholdMetres: number;          // alert if driver is moving away beyond this (default 800)
  movingAlertDebounceMinutes: number;         // minimum gap between repeat movement alerts (default 3)
  criticalLateAutoRelease: boolean;           // auto-release driver if predicted arrival > scheduled_at
};

export type GlobalDispatchSettingsRow = {
  enable_scheduled_to_urgent_conversion?: boolean | null;
  scheduled_response_window_minutes?: number | null;
  urgent_dispatch_trigger_minutes_before_pickup?: number | null;
  locked_driver_response_minutes?: number | null;
  max_driver_find_time_minutes?: number | null;
  scheduled_urgent_card_label?: string | null;
  // Commitment mode settings
  target_arrival_minutes_before_pickup?: number | null;
  not_moving_alert_after_seconds?: number | null;
  moving_away_threshold_metres?: number | null;
  moving_alert_debounce_minutes?: number | null;
  critical_late_auto_release?: boolean | null;
};

function parsePositiveInt(raw: unknown, fallback: number): number {
  if (raw == null || raw === "") return fallback;
  const n = parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseBool(raw: unknown, fallback: boolean): boolean {
  if (raw == null || raw === "") return fallback;
  if (typeof raw === "boolean") return raw;
  const v = String(raw).trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  return fallback;
}

/** Defaults aligned with Admin UI (AutoDispatchRules.tsx). */
const DEFAULTS: ScheduledDispatchConfig = {
  enableScheduledToUrgentConversion: true,
  responseWindowMinutes: 10,
  urgentTriggerMinutesBeforePickup: 5,
  lockedDriverResponseMinutes: 3,
  maxFindDriverMinutes: 3,
  scheduledUrgentCardLabel: "Scheduled • Urgent",
  // Commitment mode defaults
  targetArrivalMinutesBeforePickup: 5,
  notMovingAlertAfterSeconds: 60,
  movingAwayThresholdMetres: 800,
  movingAlertDebounceMinutes: 3,
  criticalLateAutoRelease: true,
};

export function resolveScheduledDispatchConfig(
  row: GlobalDispatchSettingsRow | null | undefined,
): ScheduledDispatchConfig {
  if (!row) return { ...DEFAULTS };

  return {
    enableScheduledToUrgentConversion: parseBool(
      row.enable_scheduled_to_urgent_conversion,
      DEFAULTS.enableScheduledToUrgentConversion,
    ),
    responseWindowMinutes: parsePositiveInt(
      row.scheduled_response_window_minutes,
      DEFAULTS.responseWindowMinutes,
    ),
    urgentTriggerMinutesBeforePickup: parsePositiveInt(
      row.urgent_dispatch_trigger_minutes_before_pickup,
      DEFAULTS.urgentTriggerMinutesBeforePickup,
    ),
    lockedDriverResponseMinutes: parsePositiveInt(
      row.locked_driver_response_minutes,
      DEFAULTS.lockedDriverResponseMinutes,
    ),
    maxFindDriverMinutes: parsePositiveInt(
      row.max_driver_find_time_minutes,
      DEFAULTS.maxFindDriverMinutes,
    ),
    scheduledUrgentCardLabel:
      row.scheduled_urgent_card_label?.trim() || DEFAULTS.scheduledUrgentCardLabel,
    // Commitment mode
    targetArrivalMinutesBeforePickup: parsePositiveInt(
      row.target_arrival_minutes_before_pickup,
      DEFAULTS.targetArrivalMinutesBeforePickup,
    ),
    notMovingAlertAfterSeconds: parsePositiveInt(
      row.not_moving_alert_after_seconds,
      DEFAULTS.notMovingAlertAfterSeconds,
    ),
    movingAwayThresholdMetres: parsePositiveInt(
      row.moving_away_threshold_metres,
      DEFAULTS.movingAwayThresholdMetres,
    ),
    movingAlertDebounceMinutes: parsePositiveInt(
      row.moving_alert_debounce_minutes,
      DEFAULTS.movingAlertDebounceMinutes,
    ),
    criticalLateAutoRelease: parseBool(
      row.critical_late_auto_release,
      DEFAULTS.criticalLateAutoRelease,
    ),
  };
}

/** Fixed-time activation: offer when now >= scheduled_at − urgentTriggerMinutes. */
export function isAcceptedScheduledActivationDue(input: {
  scheduledAt: string;
  urgentTriggerMinutesBeforePickup: number;
  nowMs: number;
}): { due: boolean; activateAtMs: number; pickupMs: number; pastPickup: boolean } {
  const pickupMs = Date.parse(input.scheduledAt);
  if (!Number.isFinite(pickupMs)) {
    return { due: false, activateAtMs: NaN, pickupMs: NaN, pastPickup: false };
  }
  const activateAtMs =
    pickupMs - input.urgentTriggerMinutesBeforePickup * 60_000;
  const pastPickup = input.nowMs > pickupMs;
  const due = input.nowMs >= activateAtMs || pastPickup;
  return { due, activateAtMs, pickupMs, pastPickup };
}

export type ScheduledTripForConversion = {
  id: string;
  scheduled_at: string;
  scheduled_broadcast_at: string | null;
  scheduled_convert_at: string | null;
  driver_id: string | null;
  confirmed_driver_id?: string | null;
};

export type OfferAnchor = {
  offered_at?: string | null;
  created_at?: string | null;
};

/**
 * Compute scheduled_broadcast_at / scheduled_convert_at from Admin
 * Scheduled Rides Configuration (Dispatch tab) — NO-PRECONFIRMED path only:
 * - urgentTriggerMinutesBeforePickup = "No-preconfirmed urgent fallback"
 * - responseWindowMinutes = "Scheduled Response Window"
 *
 * Confirmed drivers never use these anchors for activation (Commitment Policy).
 *
 * Marketplace opens `responseWindow` minutes before the urgent fallback
 * (so drivers get a full response window in Scheduled Jobs). If the booking
 * is created later than that ideal open time, broadcast_at = now (never past).
 */
export function computeScheduledDispatchAnchors(input: {
  scheduledAtIso: string;
  nowMs?: number;
  urgentTriggerMinutesBeforePickup: number;
  responseWindowMinutes: number;
}): { scheduledBroadcastAt: string; scheduledConvertAt: string } {
  const nowMs = input.nowMs ?? Date.now();
  const pickupMs = Date.parse(input.scheduledAtIso);
  const urgent = Math.max(1, Math.floor(input.urgentTriggerMinutesBeforePickup));
  const response = Math.max(1, Math.floor(input.responseWindowMinutes));

  if (!Number.isFinite(pickupMs)) {
    const iso = new Date(nowMs).toISOString();
    return { scheduledBroadcastAt: iso, scheduledConvertAt: iso };
  }

  const convertAtMs = pickupMs - urgent * 60_000;
  const idealBroadcastMs = convertAtMs - response * 60_000;
  // Never stamp a past broadcast_at — that collapses the response window to zero.
  const broadcastAtMs = nowMs < idealBroadcastMs ? idealBroadcastMs : nowMs;

  return {
    scheduledBroadcastAt: new Date(broadcastAtMs).toISOString(),
    scheduledConvertAt: new Date(convertAtMs).toISOString(),
  };
}

/** OR: pickup urgent window OR response window elapsed with no accept.
 * Admin Two paths: never for a pre-confirmed driver.
 */
export function shouldConvertScheduledToUrgent(input: {
  trip: ScheduledTripForConversion;
  config: ScheduledDispatchConfig;
  nowMs: number;
  firstOfferAnchor?: OfferAnchor | null;
  hasAcceptedOffer: boolean;
}): { convert: boolean; reason?: "urgent_pickup_window" | "response_window_no_accept" | "legacy_scheduled_convert_at" } {
  const { trip, config, nowMs, firstOfferAnchor, hasAcceptedOffer } = input;

  if (!config.enableScheduledToUrgentConversion) {
    return { convert: false };
  }
  // Confirmed / locked driver → Commitment Policy path (not fixed urgent waves).
  if (
    trip.driver_id ||
    liveAcceptedOfferBlocksConvert({
      driverId: trip.driver_id,
      confirmedDriverId: trip.confirmed_driver_id,
      hasAcceptedOffer,
    })
  ) {
    return { convert: false };
  }
  if (
    typeof trip.confirmed_driver_id === "string" &&
    trip.confirmed_driver_id.trim().length > 0
  ) {
    return { convert: false };
  }

  const pickupMs = Date.parse(trip.scheduled_at);
  if (!Number.isFinite(pickupMs)) {
    return { convert: false };
  }

  const urgentDeadlineMs =
    pickupMs - config.urgentTriggerMinutesBeforePickup * 60_000;
  if (nowMs >= urgentDeadlineMs) {
    return { convert: true, reason: "urgent_pickup_window" };
  }

  const broadcastMs = trip.scheduled_broadcast_at
    ? Date.parse(trip.scheduled_broadcast_at)
    : NaN;
  const offerMs = firstOfferAnchor
    ? Date.parse(
        String(firstOfferAnchor.offered_at ?? firstOfferAnchor.created_at ?? ""),
      )
    : NaN;
  const anchorMs = Number.isFinite(broadcastMs)
    ? broadcastMs
    : Number.isFinite(offerMs)
      ? offerMs
      : NaN;

  if (Number.isFinite(anchorMs)) {
    const responseDeadlineMs =
      anchorMs + config.responseWindowMinutes * 60_000;
    if (nowMs >= responseDeadlineMs) {
      return { convert: true, reason: "response_window_no_accept" };
    }
  }

  if (trip.scheduled_convert_at) {
    const legacyMs = Date.parse(trip.scheduled_convert_at);
    if (Number.isFinite(legacyMs) && nowMs >= legacyMs) {
      return { convert: true, reason: "legacy_scheduled_convert_at" };
    }
  }

  return { convert: false };
}

/**
 * Heat-map open-job statuses. Once a scheduled trip is in one of these,
 * Driver must show the nearby ride-offer card (not divert to Scheduled Jobs).
 */
export const SCHEDULED_OPEN_JOB_TRIP_STATUSES = [
  "searching",
  "searching_new_driver",
  "offered",
  "offering",
  "broadcasting",
  "negotiating",
  "pending",
] as const;

/**
 * Customer bookings stamp `scheduled_status: scheduled` (not `pending`).
 * Convert must still pick them up once check-in / urgent fallback is due.
 */
export const NO_PRECONFIRMED_CONVERT_SCHEDULED_STATUSES = [
  "scheduled",
  "pending",
  "broadcasting",
  "dispatching",
  "awaiting_confirmation",
  "stale",
] as const;

export function isNoPreconfirmedConvertScheduledStatus(
  scheduledStatus: string | null | undefined,
): boolean {
  const status = String(scheduledStatus ?? "").toLowerCase();
  return (NO_PRECONFIRMED_CONVERT_SCHEDULED_STATUSES as readonly string[]).includes(
    status,
  );
}

/** Patch that flips a no-accept scheduled job onto the instant nearby-card path. */
export function buildScheduledUrgentConversionPatch(input: {
  nowIso: string;
  searchingExpiresAtIso: string;
}): {
  dispatch_mode: "instant";
  scheduled_status: "converted_to_instant";
  status: "searching";
  dispatch_status: "broadcasting";
  broadcast_enabled: true;
  searching_expires_at: string;
  current_broadcast_round: 0;
  updated_at: string;
} {
  return {
    dispatch_mode: "instant",
    scheduled_status: "converted_to_instant",
    status: "searching",
    dispatch_status: "broadcasting",
    broadcast_enabled: true,
    searching_expires_at: input.searchingExpiresAtIso,
    current_broadcast_round: 0,
    updated_at: input.nowIso,
  };
}

/**
 * An `accepted` offer only blocks convert while assignment is still in flight.
 * Historical accepted rows after cancel/release must not freeze the trip as scheduled.
 */
export function liveAcceptedOfferBlocksConvert(input: {
  driverId: string | null | undefined;
  confirmedDriverId: string | null | undefined;
  hasAcceptedOffer: boolean;
}): boolean {
  if (!input.hasAcceptedOffer) return false;
  if (typeof input.driverId === "string" && input.driverId.trim().length > 0) {
    return true;
  }
  if (
    typeof input.confirmedDriverId === "string" &&
    input.confirmedDriverId.trim().length > 0
  ) {
    return true;
  }
  return false;
}

/**
 * True when auto-dispatch / Driver should treat this as an instant nearby offer.
 * Covers Scheduled → Urgent conversion AND broadcasting open jobs (heatmap).
 */
export function isOpenJobInstantRideOffer(trip: {
  dispatch_mode?: string | null;
  scheduled_status?: string | null;
  status?: string | null;
}): boolean {
  const mode = String(trip.dispatch_mode ?? "").toLowerCase();
  const scheduledStatus = String(trip.scheduled_status ?? "").toLowerCase();
  const status = String(trip.status ?? "").toLowerCase();
  if (mode === "instant" || scheduledStatus === "converted_to_instant") return true;
  return (SCHEDULED_OPEN_JOB_TRIP_STATUSES as readonly string[]).includes(status);
}

/**
 * Do not stomp scheduled marketplace rows to `searching` — that makes the
 * heat-map count an "open job" while Driver still diverts to Scheduled Jobs.
 */
export function nextAutoDispatchTripStatus(trip: {
  status?: string | null;
  dispatch_mode?: string | null;
  scheduled_status?: string | null;
}): string {
  if (String(trip.status ?? "") === "searching_new_driver") return "searching_new_driver";
  const scheduledMarketplace =
    String(trip.dispatch_mode ?? "") === "scheduled" &&
    String(trip.scheduled_status ?? "") !== "converted_to_instant";
  if (scheduledMarketplace) {
    const current = String(trip.status ?? "").toLowerCase();
    if (
      current === "offered" ||
      current === "broadcasting" ||
      current === "offering" ||
      current === "negotiating"
    ) {
      return current;
    }
    return "offered";
  }
  return "searching";
}

// ─── Commitment mode helpers ──────────────────────────────────────────────────

/**
 * Haversine distance in kilometres between two coordinates.
 */
export function haversineKm(
  lat1: number, lon1: number,
  lat2: number, lon2: number,
): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Estimate driving ETA in minutes using haversine distance.
 * Assumes 1.3× road factor and 25 km/h average city speed.
 * Returns null if coordinates are missing or degenerate.
 */
export function estimateEtaMinutes(
  driverLat: number | null | undefined,
  driverLng: number | null | undefined,
  pickupLat: number | null | undefined,
  pickupLng: number | null | undefined,
): number | null {
  if (
    driverLat == null || driverLng == null ||
    pickupLat == null || pickupLng == null
  ) return null;
  const distKm = haversineKm(driverLat, driverLng, pickupLat, pickupLng);
  const roadKm = distKm * 1.3;        // road-factor correction
  const avgSpeedKmh = 25;             // conservative city average
  return Math.max(1, Math.ceil((roadKm / avgSpeedKmh) * 60));
}

/**
 * Compute the commitment time for a scheduled trip.
 *
 * commitment_time = (scheduled_at − targetArrivalMin) − etaMinutes
 *
 * Returns null if ETA cannot be determined.
 */
export function computeCommitmentTime(args: {
  scheduledAtMs: number;
  etaMinutes: number;
  targetArrivalMinutesBeforePickup: number;
}): Date {
  const { scheduledAtMs, etaMinutes, targetArrivalMinutesBeforePickup } = args;
  const targetArrivalMs = scheduledAtMs - targetArrivalMinutesBeforePickup * 60_000;
  const commitMs = targetArrivalMs - etaMinutes * 60_000;
  return new Date(commitMs);
}

/**
 * Predicted arrival time = now + live ETA.
 */
export function predictedArrivalMs(nowMs: number, etaMinutes: number): number {
  return nowMs + etaMinutes * 60_000;
}

/**
 * Returns true if the driver is moving away from the pickup.
 * "Moving away" = distance from driver to pickup is greater than
 * (pickupLat/pickupLng vs previousLat/previousLng) by more than thresholdMetres.
 */
export function isMovingAway(args: {
  driverLat: number;
  driverLng: number;
  pickupLat: number;
  pickupLng: number;
  previousLat: number | null | undefined;
  previousLng: number | null | undefined;
  thresholdMetres: number;
}): boolean {
  const { driverLat, driverLng, pickupLat, pickupLng, previousLat, previousLng, thresholdMetres } = args;
  if (previousLat == null || previousLng == null) return false;

  const currentDistM = haversineKm(driverLat, driverLng, pickupLat, pickupLng) * 1000;
  const previousDistM = haversineKm(previousLat, previousLng, pickupLat, pickupLng) * 1000;

  // Driver is moving away if current distance > previous distance + threshold
  return currentDistM > previousDistM + thresholdMetres;
}
