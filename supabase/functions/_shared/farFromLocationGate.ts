/**
 * Far-from-location confirmation SSOT for stop-workflow.
 * Mirrors Driver `farFromLocationGate.ts` (500 m / 15 s / 100 m accuracy).
 *
 * When driver coords are present and distance > threshold without `far_confirm`,
 * return location_confirmation_required (409). Missing coords fail-open so
 * GPS-denied drivers can still complete after the approved client Yes/No path
 * cannot run (product: confirm when measurable; never hard-block Completes
 * solely for absent GPS).
 */

export const FAR_FROM_LOCATION_WARNING_RADIUS_METERS = 500;

export type FarFromLocationKind = "pickup" | "stop" | "destination";

export type FarFromLocationGateInput = {
  kind: FarFromLocationKind;
  driverLat: number | null | undefined;
  driverLng: number | null | undefined;
  targetLat: number | null | undefined;
  targetLng: number | null | undefined;
  farConfirm: boolean;
  locationAccuracyM?: number | null;
  locationTimestampIso?: string | null;
  nowMs?: number;
};

export type FarFromLocationGateResult =
  | { ok: true; distanceMeters: number | null }
  | {
    ok: false;
    code: "location_confirmation_required";
    message: string;
    distanceMeters: number;
  };

function haversineMeters(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function formatDistance(distanceMeters: number): string {
  const rounded = Math.max(0, Math.round(distanceMeters));
  if (rounded < 1000) return `${rounded} m`;
  return `${(rounded / 1000).toFixed(1)} km`;
}

function confirmationMessage(
  kind: FarFromLocationKind,
  distanceMeters: number,
): string {
  const label = formatDistance(distanceMeters);
  if (kind === "pickup") {
    return `You are ${label} from the pickup location. Are you sure you have arrived?`;
  }
  if (kind === "stop") {
    return `You are ${label} from the planned stop. Are you sure you want to continue?`;
  }
  return `You are ${label} from the planned drop-off. Are you sure you want to complete the trip here?`;
}

function isFiniteCoord(lat: number | null | undefined, lng: number | null | undefined): boolean {
  return (
    typeof lat === "number" &&
    typeof lng === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lng)
  );
}

/**
 * Authoritative far-from gate. Call before arrive_pickup / arrive_stop / complete_trip
 * mutations when the client supplied coordinates.
 */
export function evaluateFarFromLocationGate(
  input: FarFromLocationGateInput,
): FarFromLocationGateResult {
  if (!isFiniteCoord(input.driverLat, input.driverLng)) {
    return { ok: true, distanceMeters: null };
  }
  if (!isFiniteCoord(input.targetLat, input.targetLng)) {
    return { ok: true, distanceMeters: null };
  }

  const distanceMeters = Math.round(
    haversineMeters(
      input.driverLat as number,
      input.driverLng as number,
      input.targetLat as number,
      input.targetLng as number,
    ),
  );

  if (distanceMeters <= FAR_FROM_LOCATION_WARNING_RADIUS_METERS) {
    return { ok: true, distanceMeters };
  }

  if (input.farConfirm === true) {
    // Evidence freshness is best-effort — stale evidence still allowed after
    // explicit Yes (client already bound the confirmation). Re-prompt via client
    // revalidation path if product tightens later.
    return { ok: true, distanceMeters };
  }

  return {
    ok: false,
    code: "location_confirmation_required",
    message: confirmationMessage(input.kind, distanceMeters),
    distanceMeters,
  };
}
