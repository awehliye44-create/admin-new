/**
 * Towards Destination dispatch filter helpers.
 * Expired sessions must not hard-filter offers (Bug: sticky filter after duration).
 */

export type TowardsDestinationSettingsRow = {
  driver_id: string;
  towards_destination_active?: boolean | null;
  towards_destination_lat?: number | null;
  towards_destination_lng?: number | null;
  towards_destination_expires_at?: string | null;
};

export type TowardsDestinationPoint = { lat: number; lng: number };

/** Valid geographic coords — reject Null Island / non-finite. */
export function isValidTowardsDestinationCoord(
  lat: number | null | undefined,
  lng: number | null | undefined,
): boolean {
  if (typeof lat !== "number" || typeof lng !== "number") return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
  if (Math.abs(lat) < 1e-6 && Math.abs(lng) < 1e-6) return false;
  return true;
}

export function isTowardsDestinationSessionActive(args: {
  active: boolean | null | undefined;
  lat: number | null | undefined;
  lng: number | null | undefined;
  expiresAt: string | null | undefined;
  nowMs?: number;
}): boolean {
  if (args.active !== true) return false;
  if (!isValidTowardsDestinationCoord(args.lat, args.lng)) return false;
  if (args.expiresAt) {
    const exp = Date.parse(args.expiresAt);
    if (Number.isFinite(exp) && exp <= (args.nowMs ?? Date.now())) {
      return false;
    }
  }
  return true;
}

/** Build driver_id → destination map; excludes expired / invalid rows. */
export function buildTowardsDestinationMap(
  rows: TowardsDestinationSettingsRow[] | null | undefined,
  nowMs: number = Date.now(),
): Map<string, TowardsDestinationPoint> {
  const map = new Map<string, TowardsDestinationPoint>();
  for (const ds of rows ?? []) {
    if (
      !isTowardsDestinationSessionActive({
        active: ds.towards_destination_active,
        lat: ds.towards_destination_lat,
        lng: ds.towards_destination_lng,
        expiresAt: ds.towards_destination_expires_at,
        nowMs,
      })
    ) {
      continue;
    }
    map.set(ds.driver_id, {
      lat: ds.towards_destination_lat as number,
      lng: ds.towards_destination_lng as number,
    });
  }
  return map;
}
