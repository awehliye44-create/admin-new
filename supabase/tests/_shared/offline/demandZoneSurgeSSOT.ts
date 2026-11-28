/** Offline test/audit-only helpers; not part of Edge uploads. */
import { DemandTripCandidate, OPEN_TRIP_DEMAND_STATUSES, SurgeZone, DemandZoneSettings, SurgeResolution, findPickupZone, multiplierForLevel, SurgeQuote } from "../../../functions/_shared/demandZoneSurgeSSOT.ts";


/** Counts each unique open, unassigned, in-lifetime trip exactly once. */
export function countOpenTrips(
  trips: DemandTripCandidate[],
  nowMs: number,
  openTripMaxLifetimeMinutes: number,
): number {
  const lifetimeMs = openTripMaxLifetimeMinutes * 60_000;
  const seen = new Set<string>();
  for (const t of trips) {
    if (t.driver_id) continue;
    if (!(OPEN_TRIP_DEMAND_STATUSES as readonly string[]).includes(String(t.status).toLowerCase())) continue;
    const created = new Date(t.created_at).getTime();
    if (!Number.isFinite(created)) continue;
    if (nowMs - created > lifetimeMs) continue;
    seen.add(t.trip_id);
  }
  return seen.size;
}


/**
 * Backend-only surge resolution. The pickup coordinate is the sole input;
 * destination never influences surge.
 */
export function resolveZoneSurge(params: {
  zones: SurgeZone[];
  settings: DemandZoneSettings | null;
  serviceAreaId: string;
  pickupLat: number;
  pickupLng: number;
}): SurgeResolution {
  const { zones, settings, serviceAreaId, pickupLat, pickupLng } = params;
  if (!settings) {
    return { zone_id: null, confirmed_demand_level: null, applied_multiplier: 1, surge_enabled: false, reason: 'NO_SETTINGS' };
  }
  const zone = findPickupZone(zones, pickupLat, pickupLng, serviceAreaId);
  if (!zone) {
    return { zone_id: null, confirmed_demand_level: null, applied_multiplier: 1, surge_enabled: settings.surge_enabled, reason: 'NO_ZONE' };
  }
  if (!settings.surge_enabled) {
    return {
      zone_id: zone.id,
      confirmed_demand_level: zone.confirmed_demand_level,
      applied_multiplier: 1,
      surge_enabled: false,
      reason: 'SURGE_DISABLED',
    };
  }
  return {
    zone_id: zone.id,
    confirmed_demand_level: zone.confirmed_demand_level,
    applied_multiplier: multiplierForLevel(settings, zone.confirmed_demand_level),
    surge_enabled: true,
    reason: 'ZONE_MULTIPLIER',
  };
}


/** A quote must be refreshed when the pickup moves out of the quoted zone or it expires. */
export function quoteRequiresRefresh(
  quote: SurgeQuote,
  currentPickup: { lat: number; lng: number },
  nowMs: number,
  zones: SurgeZone[],
): boolean {
  if (new Date(quote.quote_expires_at).getTime() <= nowMs) return true;
  const zone = findPickupZone(zones, currentPickup.lat, currentPickup.lng, quote.service_area_id);
  return (zone?.id ?? null) !== quote.zone_id;
}


/** Client-supplied multipliers are never trusted — the locked quote value wins. */
export function lockedBookingMultiplier(quote: SurgeQuote, _clientSubmittedMultiplier?: unknown): number {
  return quote.applied_multiplier;
}

export * from "../../../functions/_shared/demandZoneSurgeSSOT.ts";
export * from "../../../../shared/edgePresentation/demandZoneSurgeSSOT.ts";
