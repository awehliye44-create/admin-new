/**
 * Far-from-location confirmation SSOT for stop-workflow arrive/complete actions.
 * Mirrors the Driver client gate (500m warning radius) — never invents coordinates.
 */

export type FarFromLocationAction = "arrive_pickup" | "arrive_stop" | "complete_trip";

export const FAR_FROM_LOCATION_WARNING_RADIUS_METRES = 500;
export const FAR_FROM_LOCATION_MAX_LOCATION_AGE_MS = 15_000;
export const FAR_FROM_LOCATION_MAX_ACCURACY_METRES = 100;

export type FarFromLocationEvaluation =
  | { status: "not_applicable"; reason: string }
  | {
      status: "within_range";
      distance_metres: number;
      warning_radius_metres: number;
      reason: string;
    }
  | {
      status: "confirmation_required";
      distance_metres: number;
      warning_radius_metres: number;
      reason: string;
    }
  | {
      status: "confirmed";
      distance_metres: number;
      warning_radius_metres: number;
      reason: string;
    };

function haversineMetres(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function evaluateFarFromLocationConfirmation(input: {
  action: FarFromLocationAction;
  targetLat: number | null | undefined;
  targetLng: number | null | undefined;
  driverLat: number | undefined;
  driverLng: number | undefined;
  locationTimestampMs: number | null | undefined;
  locationAccuracyM: number | undefined;
  farConfirm: boolean | undefined;
  nowMs?: number;
  warningRadiusMetres?: number;
}): FarFromLocationEvaluation {
  const warning =
    input.warningRadiusMetres ?? FAR_FROM_LOCATION_WARNING_RADIUS_METRES;
  const targetLat = input.targetLat;
  const targetLng = input.targetLng;
  const driverLat = input.driverLat;
  const driverLng = input.driverLng;

  if (
    targetLat == null ||
    targetLng == null ||
    !Number.isFinite(targetLat) ||
    !Number.isFinite(targetLng)
  ) {
    return { status: "not_applicable", reason: "missing_target_coordinates" };
  }
  if (
    driverLat == null ||
    driverLng == null ||
    !Number.isFinite(driverLat) ||
    !Number.isFinite(driverLng)
  ) {
    return { status: "not_applicable", reason: "missing_driver_coordinates" };
  }

  const distance_metres = Math.round(
    haversineMetres(driverLat, driverLng, targetLat, targetLng),
  );

  if (distance_metres <= warning) {
    return {
      status: "within_range",
      distance_metres,
      warning_radius_metres: warning,
      reason: "within_warning_radius",
    };
  }

  if (input.farConfirm === true) {
    return {
      status: "confirmed",
      distance_metres,
      warning_radius_metres: warning,
      reason: "driver_confirmed_far_override",
    };
  }

  return {
    status: "confirmation_required",
    distance_metres,
    warning_radius_metres: warning,
    reason: "beyond_warning_radius",
  };
}

export function farFromLocationBlockedMessage(
  action: FarFromLocationAction,
  distanceMetres: number | undefined,
): string {
  const rounded =
    typeof distanceMetres === "number" && Number.isFinite(distanceMetres)
      ? Math.max(0, Math.round(distanceMetres))
      : null;
  const label =
    rounded == null
      ? "a long way"
      : rounded < 1000
        ? `${rounded} m`
        : `${(rounded / 1000).toFixed(1)} km`;

  if (action === "arrive_pickup") {
    return `You are ${label} from the pickup location. Confirm you have arrived.`;
  }
  if (action === "arrive_stop") {
    return `You are ${label} from the planned stop. Confirm you want to continue.`;
  }
  return `You are ${label} from the planned drop-off. Confirm you want to complete the trip here.`;
}

export function farFromLocationAuditEventType(
  action: FarFromLocationAction,
): string {
  if (action === "arrive_pickup") return "far_from_pickup_confirmed";
  if (action === "arrive_stop") return "far_from_stop_confirmed";
  return "far_from_dropoff_confirmed";
}
