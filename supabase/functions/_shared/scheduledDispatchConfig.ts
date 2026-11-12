/**
 * Scheduled dispatch config — global_dispatch_settings SSOT.
 * Admin Auto-Dispatch Rules UI writes this table; scheduled-dispatch reads it.
 *
 * Activation uses fixed Local/Long T-minutes (scheduledActivationSSOT).
 * Legacy ETA commitment activation is removed.
 */

import {
  resolveScheduledActivationConfig,
  type ScheduledActivationConfig,
} from "./scheduledActivationSSOT.ts";
import { resolveNextRematchBroadcastRound } from "./driverCancelRematch.ts";

export type ScheduledDispatchConfig = {
  enableScheduledToUrgentConversion: boolean;
  responseWindowMinutes: number;
  urgentTriggerMinutesBeforePickup: number;
  lockedDriverResponseMinutes: number;
  maxFindDriverMinutes: number;
  scheduledUrgentCardLabel: string;
  /** Local / Long activation SSOT (Admin Activation tab). */
  activation: ScheduledActivationConfig;
};

export type GlobalDispatchSettingsRow = {
  enable_scheduled_to_urgent_conversion?: boolean | null;
  scheduled_response_window_minutes?: number | null;
  urgent_dispatch_trigger_minutes_before_pickup?: number | null;
  locked_driver_response_minutes?: number | null;
  max_driver_find_time_minutes?: number | null;
  scheduled_urgent_card_label?: string | null;
  long_trip_threshold_minutes?: number | null;
  local_activation_minutes_before_pickup?: number | null;
  long_activation_minutes_before_pickup?: number | null;
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
  urgentTriggerMinutesBeforePickup: 9,
  lockedDriverResponseMinutes: 3,
  maxFindDriverMinutes: 3,
  scheduledUrgentCardLabel: "Scheduled • Urgent",
  activation: resolveScheduledActivationConfig(null),
};

export function resolveScheduledDispatchConfig(
  row: GlobalDispatchSettingsRow | null | undefined,
): ScheduledDispatchConfig {
  if (!row) return { ...DEFAULTS, activation: { ...DEFAULTS.activation } };

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
    activation: resolveScheduledActivationConfig(row),
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
  /**
   * Marketplace publication / Scheduled Jobs visibility only.
   * MUST NOT start the NRO response-window countdown.
   */
  scheduled_broadcast_at: string | null;
  scheduled_convert_at: string | null;
  /**
   * When legitimate fallback / NRO dispatch actually started (activation or
   * Broadcast Now / first wave). Response window anchors here — not marketplace open.
   */
  broadcast_started_at?: string | null;
  driver_id: string | null;
  confirmed_driver_id?: string | null;
};

export type OfferAnchor = {
  offered_at?: string | null;
  created_at?: string | null;
};

/**
 * Compute ideal scheduled_broadcast_at / scheduled_convert_at — NO-PRECONFIRMED path:
 * - urgentTriggerMinutesBeforePickup = "No-preconfirmed Fallback" (convert / urgent)
 * - responseWindowMinutes = Admin "Broadcast At" suggestion spacing only
 *
 * Pre-confirmed drivers activate via Local/Long T-minutes (scheduledActivationSSOT),
 * not these anchors.
 *
 * Create-time HELD bookings stamp convert_at only (T−urgent). Marketplace
 * `scheduled_broadcast_at` is set by auto-publish / Make Available (visibility).
 * `scheduledBroadcastAt` here remains the *ideal* open time for Admin helpers
 * (never auto-applied at create). Marketplace open ≠ response-window start.
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
  // Ideal Admin Broadcast At suggestion — never past (collapses response window).
  const broadcastAtMs = nowMs < idealBroadcastMs ? idealBroadcastMs : nowMs;

  return {
    scheduledBroadcastAt: new Date(broadcastAtMs).toISOString(),
    scheduledConvertAt: new Date(convertAtMs).toISOString(),
  };
}

/**
 * Resolve when the NRO / fallback response window actually started.
 * Marketplace `scheduled_broadcast_at` is intentionally ignored.
 */
export function resolveScheduledResponseWindowAnchorMs(input: {
  broadcastStartedAt?: string | null;
  firstOfferAnchor?: OfferAnchor | null;
}): number {
  const startedMs = input.broadcastStartedAt
    ? Date.parse(String(input.broadcastStartedAt))
    : NaN;
  const offerMs = input.firstOfferAnchor
    ? Date.parse(
      String(
        input.firstOfferAnchor.offered_at ??
          input.firstOfferAnchor.created_at ??
          "",
      ),
    )
    : NaN;
  if (Number.isFinite(startedMs) && Number.isFinite(offerMs)) {
    return Math.min(startedMs, offerMs);
  }
  if (Number.isFinite(startedMs)) return startedMs;
  if (Number.isFinite(offerMs)) return offerMs;
  return NaN;
}

/** OR: pickup urgent window OR response window elapsed with no accept.
 * Admin Two paths: never for a pre-confirmed driver.
 *
 * Response window starts only after legitimate fallback/NRO dispatch
 * (`broadcast_started_at` or first ride_offer) — never from marketplace publish.
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
  // Confirmed / locked driver → Local/Long activation NRO path (not urgent convert).
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

  const anchorMs = resolveScheduledResponseWindowAnchorMs({
    broadcastStartedAt: trip.broadcast_started_at,
    firstOfferAnchor,
  });

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
 * Customer bookings stamp `scheduled_status: admin_held` (Admin HELD).
 * Legacy rows may still be `scheduled` / `pending`.
 * T−urgent convert must still pick held jobs up when no driver is pre-confirmed.
 */
export const NO_PRECONFIRMED_CONVERT_SCHEDULED_STATUSES = [
  "admin_held",
  "scheduled",
  "pending",
  "broadcasting",
  "dispatching",
  "awaiting_confirmation",
  "stale",
] as const;

/** Create-time Admin HELD — driver marketplace must stay closed. */
export const ADMIN_HELD_SCHEDULED_STATUS = "admin_held" as const;

export function isAdminHeldScheduledStatus(
  scheduledStatus: string | null | undefined,
): boolean {
  return String(scheduledStatus ?? "").trim().toLowerCase() === ADMIN_HELD_SCHEDULED_STATUS;
}

export function isNoPreconfirmedConvertScheduledStatus(
  scheduledStatus: string | null | undefined,
): boolean {
  const status = String(scheduledStatus ?? "").toLowerCase();
  return (NO_PRECONFIRMED_CONVERT_SCHEDULED_STATUSES as readonly string[]).includes(
    status,
  );
}

/**
 * Airport / fare-enrich hold sets broadcast_enabled=false. Conversion,
 * Broadcast Now, rematch and auto-publish must NOT reopen dispatch while the
 * hold is active — even when a caller passes forceOpen.
 */
export function resolveConversionBroadcastEnabled(input: {
  currentBroadcastEnabled?: boolean | null;
  /** Ignored while currentBroadcastEnabled === false (airport pricing lock). */
  forceOpen?: boolean;
}): boolean {
  const current = input.currentBroadcastEnabled;
  if (current === false) return false;
  if (input.forceOpen === true) return true;
  return current !== false;
}

/** Patch that flips a no-accept scheduled job onto the instant nearby-card path. */
export function buildScheduledUrgentConversionPatch(input: {
  nowIso: string;
  searchingExpiresAtIso: string;
  /**
   * Max ride_offers.broadcast_round already used on this trip (scheduled
   * broadcast / rematch history). Anchors current_broadcast_round so the first
   * post-convert auto-dispatch sequence cannot collide with UNIQUE
   * (trip_id, driver_id, broadcast_round). Omit / 0 when no prior offers.
   */
  maxExistingBroadcastRound?: number | null;
  /**
   * Absolute sequences (Admin Max Dispatch Rounds × 3), same stamp as instant
   * book post-commit. Ensures convert can run standard waves through the
   * find-driver search window (typically 6 minutes).
   */
  maxBroadcastSequences?: number | null;
  /**
   * When false, preserve airport / fare-enrich broadcast hold.
   * Rematch paths that must reopen dispatch pass true (default).
   */
  broadcastEnabled?: boolean;
}): {
  dispatch_mode: "instant";
  scheduled_status: "converted_to_instant";
  status: "searching";
  dispatch_status: "broadcasting";
  broadcast_enabled: boolean;
  searching_expires_at: string;
  current_broadcast_round: number;
  max_broadcast_rounds: number;
  updated_at: string;
  pending_release_kind: null;
  pending_release_at: null;
  pending_release_driver_id: null;
} {
  const maxExisting = input.maxExistingBroadcastRound ?? 0;
  const cycleEnd = resolveNextRematchBroadcastRound(maxExisting);
  // At least one full W1–W2–W3 of headroom after history, and never below Admin × 3.
  const adminSequences =
    typeof input.maxBroadcastSequences === "number" &&
      Number.isFinite(input.maxBroadcastSequences) &&
      input.maxBroadcastSequences > 0
      ? Math.floor(input.maxBroadcastSequences)
      : 9;
  const maxBroadcastRounds = Math.max(adminSequences, cycleEnd + 3);

  return {
    dispatch_mode: "instant",
    scheduled_status: "converted_to_instant",
    status: "searching",
    dispatch_status: "broadcasting",
    broadcast_enabled: input.broadcastEnabled !== false,
    searching_expires_at: input.searchingExpiresAtIso,
    // Fresh W1 of the next cycle after offer history (0 when none → next seq 1).
    current_broadcast_round: cycleEnd,
    max_broadcast_rounds: maxBroadcastRounds,
    updated_at: input.nowIso,
    // T−urgent overrides any later Assign At / Broadcast At.
    pending_release_kind: null,
    pending_release_at: null,
    pending_release_driver_id: null,
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
 * Haversine is an *estimate*, not a guaranteed upper bound on road travel time
 * (traffic / roads can exceed it). Conservative road factor + slow city speed
 * reduce underestimation for JIT fallback only — prefer routed ETA when available.
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
  const roadKm = distKm * 1.45; // conservative road-factor (was 1.3)
  const avgSpeedKmh = 20; // slower than typical city average — do not underestimate
  return Math.max(3, Math.ceil((roadKm / avgSpeedKmh) * 60));
}

/**
 * @deprecated ETA commitment activation removed — use scheduledActivationSSOT.
 * Kept as a no-op helper only if legacy tests import it; do not use for activation.
 */
export function computeCommitmentTime(args: {
  scheduledAtMs: number;
  etaMinutes: number;
  targetArrivalMinutesBeforePickup: number;
}): Date {
  const { scheduledAtMs, targetArrivalMinutesBeforePickup } = args;
  return new Date(scheduledAtMs - targetArrivalMinutesBeforePickup * 60_000);
}

/** Predicted arrival time = now + live ETA (shared routing; not scheduled activation). */
export function predictedArrivalMs(nowMs: number, etaMinutes: number): number {
  return nowMs + etaMinutes * 60_000;
}

/**
 * Returns true if the driver is moving away from the pickup.
 * Shared geo helper — not part of scheduled Commitment Policy.
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
