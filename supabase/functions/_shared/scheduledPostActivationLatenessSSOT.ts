/**
 * Post–Heading to Pickup lateness monitoring (D6).
 * Planning early-arrival target is never a cancel/reassign deadline.
 * Detect past scheduled_at / stale GPS → ops alert + optional traffic_delay.
 */

export const POST_ACTIVATION_STALE_GPS_MS = 5 * 60_000;
export const TRAFFIC_DELAY_DEDUPE_PREFIX = "traffic_delay_scheduled:";

export function shouldSurfacePostActivationLateness(input: {
  nowMs: number;
  scheduledAtIso: string | null | undefined;
  status: string | null | undefined;
  scheduledStatus: string | null | undefined;
  driverId: string | null | undefined;
  gpsSampledAtIso?: string | null;
}): {
  lateVsPickup: boolean;
  staleGps: boolean;
  minutesPastPickup: number | null;
  escalate: boolean;
} {
  const status = String(input.status ?? "").trim().toLowerCase();
  const sched = String(input.scheduledStatus ?? "").trim().toLowerCase();
  const driver = String(input.driverId ?? "").trim();
  const activeEnRoute =
    Boolean(driver) &&
    (status === "en_route_to_pickup" ||
      status === "en_route" ||
      sched === "driver_en_route");
  if (!activeEnRoute) {
    return {
      lateVsPickup: false,
      staleGps: false,
      minutesPastPickup: null,
      escalate: false,
    };
  }

  const pickupMs = input.scheduledAtIso
    ? Date.parse(String(input.scheduledAtIso))
    : NaN;
  const lateVsPickup =
    Number.isFinite(pickupMs) && input.nowMs > pickupMs;
  const minutesPastPickup = lateVsPickup
    ? Math.floor((input.nowMs - pickupMs) / 60_000)
    : null;

  const gpsMs = input.gpsSampledAtIso
    ? Date.parse(String(input.gpsSampledAtIso))
    : NaN;
  const staleGps =
    !Number.isFinite(gpsMs) ||
    input.nowMs - gpsMs > POST_ACTIVATION_STALE_GPS_MS;

  return {
    lateVsPickup,
    staleGps,
    minutesPastPickup,
    escalate: lateVsPickup || staleGps,
  };
}

export function buildTrafficDelayNotificationId(tripId: string): string {
  return `${TRAFFIC_DELAY_DEDUPE_PREFIX}${tripId}`;
}

export function buildPostActivationLatenessOpsAlert(input: {
  tripId: string;
  driverId: string;
  nowIso: string;
  lateVsPickup: boolean;
  staleGps: boolean;
  minutesPastPickup: number | null;
}): {
  fingerprint: string;
  title: string;
  related_trip_id: string;
  metadata: Record<string, unknown>;
} {
  const kind = input.lateVsPickup
    ? input.staleGps
      ? "late_and_stale_gps"
      : "past_scheduled_pickup"
    : "stale_gps";
  return {
    fingerprint: `post_activation_lateness:${input.tripId}:${kind}`,
    title: input.lateVsPickup
      ? "Scheduled trip late — driver still heading to pickup"
      : "Scheduled trip — stale driver GPS after Heading to Pickup",
    related_trip_id: input.tripId,
    metadata: {
      trip_id: input.tripId,
      driver_id: input.driverId,
      late_vs_pickup: input.lateVsPickup,
      stale_gps: input.staleGps,
      minutes_past_pickup: input.minutesPastPickup,
      observed_at: input.nowIso,
      auto_reassign: false,
      planning_early_target_not_deadline: true,
    },
  };
}
