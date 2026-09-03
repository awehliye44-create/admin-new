/**
 * ONECAB Driver Demand Zones — Heat-map + zone-based automatic surge SSOT.
 *
 * Pure functions only. No IO. Shared by:
 *  - Admin panel (settings validation, colour rendering, read-only gating)
 *  - compute-driver-demand-zones edge function (thresholds + hysteresis)
 *  - estimate-fare edge function (zone-based multiplier resolution)
 *
 * Rules that must never be broken:
 *  - Colours are presentation only. They never affect level, multiplier or fare.
 *  - Surge is resolved from the PICKUP zone only, never the whole service area.
 *  - Clients never supply a multiplier.
 */

export type DemandLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export const DEMAND_LEVELS: DemandLevel[] = ['LOW', 'MEDIUM', 'HIGH'];

export interface DemandZoneSettings {
  service_area_id: string;
  heat_map_enabled: boolean;
  recompute_interval_minutes: number;
  open_trip_max_lifetime_minutes: number;
  low_min_trips: number;
  low_max_trips: number;
  medium_min_trips: number;
  medium_max_trips: number;
  high_min_trips: number;
  consecutive_checks_required: number;
  zone_radius_meters: number;
  manual_zones_enabled: boolean;
  colour_low: string;
  colour_medium: string;
  colour_high: string;
  surge_enabled: boolean;
  multiplier_low: number;
  multiplier_medium: number | null;
  multiplier_high: number | null;
  max_multiplier: number;
}

/** Safe defaults applied to existing service areas by migration A. */
export const DEMAND_ZONE_SETTINGS_DEFAULTS = {
  heat_map_enabled: true,
  recompute_interval_minutes: 2,
  open_trip_max_lifetime_minutes: 6,
  low_min_trips: 1,
  low_max_trips: 2,
  medium_min_trips: 3,
  medium_max_trips: 5,
  high_min_trips: 6,
  consecutive_checks_required: 2,
  zone_radius_meters: 700,
  manual_zones_enabled: true,
  colour_low: '#22C55E',
  colour_medium: '#F59E0B',
  colour_high: '#EF4444',
  surge_enabled: false,
  multiplier_low: 1.0,
  multiplier_medium: null as number | null,
  multiplier_high: null as number | null,
  max_multiplier: 2.0,
} as const;

export const DEFAULT_LEVEL_COLOURS: Record<DemandLevel, string> = {
  LOW: DEMAND_ZONE_SETTINGS_DEFAULTS.colour_low,
  MEDIUM: DEMAND_ZONE_SETTINGS_DEFAULTS.colour_medium,
  HIGH: DEMAND_ZONE_SETTINGS_DEFAULTS.colour_high,
};

/** Presentation-only fill/stroke opacity per level. */
export const LEVEL_OPACITY: Record<DemandLevel, { fill: number; stroke: number }> = {
  LOW: { fill: 0.18, stroke: 0.45 },
  MEDIUM: { fill: 0.28, stroke: 0.55 },
  HIGH: { fill: 0.38, stroke: 0.72 },
};

// ─── Colours ───

const HEX_RE = /^#?[0-9a-fA-F]{6}$/;

export function isValidHexColour(value: unknown): boolean {
  return typeof value === 'string' && HEX_RE.test(value.trim());
}

/** Normalises to uppercase `#RRGGBB`. Throws on invalid input. */
export function normaliseHexColour(value: string): string {
  if (!isValidHexColour(value)) {
    throw new Error(`INVALID_HEX_COLOUR:${value}`);
  }
  const raw = value.trim().replace(/^#/, '');
  return `#${raw.toUpperCase()}`;
}

export function levelColour(settings: Pick<DemandZoneSettings, 'colour_low' | 'colour_medium' | 'colour_high'> | null | undefined, level: DemandLevel): string {
  if (!settings) return DEFAULT_LEVEL_COLOURS[level];
  const raw =
    level === 'HIGH' ? settings.colour_high : level === 'MEDIUM' ? settings.colour_medium : settings.colour_low;
  return isValidHexColour(raw) ? normaliseHexColour(raw) : DEFAULT_LEVEL_COLOURS[level];
}

// ─── Validation ───

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateThresholds(s: Pick<DemandZoneSettings,
  'low_min_trips' | 'low_max_trips' | 'medium_min_trips' | 'medium_max_trips' | 'high_min_trips' | 'consecutive_checks_required' | 'recompute_interval_minutes' | 'open_trip_max_lifetime_minutes' | 'zone_radius_meters'>): ValidationResult {
  const errors: string[] = [];
  const int = (n: number) => Number.isInteger(n);

  if (!int(s.low_min_trips) || s.low_min_trips < 0) errors.push('LOW_MIN_INVALID');
  if (!int(s.low_max_trips) || s.low_max_trips < s.low_min_trips) errors.push('LOW_MAX_LT_LOW_MIN');
  if (!int(s.medium_min_trips) || s.medium_min_trips <= s.low_max_trips) errors.push('MEDIUM_MIN_NOT_GT_LOW_MAX');
  if (!int(s.medium_max_trips) || s.medium_max_trips < s.medium_min_trips) errors.push('MEDIUM_MAX_LT_MEDIUM_MIN');
  if (!int(s.high_min_trips) || s.high_min_trips <= s.medium_max_trips) errors.push('HIGH_MIN_NOT_GT_MEDIUM_MAX');
  // No gaps allowed between contiguous ranges.
  if (int(s.medium_min_trips) && s.medium_min_trips !== s.low_max_trips + 1) errors.push('GAP_BETWEEN_LOW_AND_MEDIUM');
  if (int(s.high_min_trips) && s.high_min_trips !== s.medium_max_trips + 1) errors.push('GAP_BETWEEN_MEDIUM_AND_HIGH');

  if (!int(s.consecutive_checks_required) || s.consecutive_checks_required < 1) errors.push('CONSECUTIVE_CHECKS_INVALID');
  if (!int(s.recompute_interval_minutes) || s.recompute_interval_minutes < 1) errors.push('RECOMPUTE_INTERVAL_INVALID');
  if (!int(s.open_trip_max_lifetime_minutes) || s.open_trip_max_lifetime_minutes < 1) errors.push('OPEN_TRIP_LIFETIME_INVALID');
  if (!int(s.zone_radius_meters) || s.zone_radius_meters <= 0) errors.push('ZONE_RADIUS_INVALID');

  return { valid: errors.length === 0, errors };
}

export function validateColours(s: Pick<DemandZoneSettings, 'colour_low' | 'colour_medium' | 'colour_high'>): ValidationResult {
  const errors: string[] = [];
  if (!isValidHexColour(s.colour_low)) errors.push('COLOUR_LOW_INVALID');
  if (!isValidHexColour(s.colour_medium)) errors.push('COLOUR_MEDIUM_INVALID');
  if (!isValidHexColour(s.colour_high)) errors.push('COLOUR_HIGH_INVALID');
  return { valid: errors.length === 0, errors };
}

export function validateSurge(s: Pick<DemandZoneSettings,
  'surge_enabled' | 'multiplier_low' | 'multiplier_medium' | 'multiplier_high' | 'max_multiplier'>): ValidationResult {
  const errors: string[] = [];
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

  if (!ok(s.max_multiplier) || s.max_multiplier < 1) errors.push('MAX_MULTIPLIER_INVALID');
  const check = (label: string, v: number | null | undefined, required: boolean) => {
    if (v == null) {
      if (required) errors.push(`${label}_REQUIRED`);
      return;
    }
    if (!ok(v)) { errors.push(`${label}_INVALID`); return; }
    if (v < 1) errors.push(`${label}_BELOW_ONE`);
    if (ok(s.max_multiplier) && v > s.max_multiplier) errors.push(`${label}_ABOVE_MAX`);
    if (Math.round(v * 100) !== Number((v * 100).toFixed(6))) errors.push(`${label}_PRECISION`);
  };

  check('MULTIPLIER_LOW', s.multiplier_low, true);
  check('MULTIPLIER_MEDIUM', s.multiplier_medium, s.surge_enabled);
  check('MULTIPLIER_HIGH', s.multiplier_high, s.surge_enabled);

  if (ok(s.multiplier_low) && ok(s.multiplier_medium) && s.multiplier_medium < s.multiplier_low) {
    errors.push('MEDIUM_LT_LOW');
  }
  if (ok(s.multiplier_medium) && ok(s.multiplier_high) && s.multiplier_high < s.multiplier_medium) {
    errors.push('HIGH_LT_MEDIUM');
  }

  return { valid: errors.length === 0, errors };
}

export function validateDemandZoneSettings(s: Omit<DemandZoneSettings, 'service_area_id'> & { service_area_id?: string }): ValidationResult {
  const errors = [
    ...validateThresholds(s).errors,
    ...validateColours(s).errors,
    ...validateSurge(s).errors,
  ];
  if (!s.service_area_id) errors.push('SERVICE_AREA_REQUIRED');
  return { valid: errors.length === 0, errors };
}

// ─── Demand level derivation + hysteresis ───

export function proposeLevel(
  openTripCount: number,
  s: Pick<DemandZoneSettings, 'low_min_trips' | 'low_max_trips' | 'medium_min_trips' | 'medium_max_trips' | 'high_min_trips'>,
): DemandLevel {
  if (openTripCount >= s.high_min_trips) return 'HIGH';
  if (openTripCount >= s.medium_min_trips) return 'MEDIUM';
  return 'LOW';
}

export interface ZoneEvaluationState {
  proposed_demand_level: DemandLevel | null;
  confirmed_demand_level: DemandLevel;
  consecutive_match_count: number;
}

export interface ZoneEvaluationResult extends ZoneEvaluationState {
  changed: boolean;
  previous_confirmed_demand_level: DemandLevel;
}

/**
 * Applies the configured consecutive-check hysteresis.
 * A level (including a return to LOW) only becomes confirmed after
 * `consecutive_checks_required` identical consecutive proposals.
 */
export function applyHysteresis(
  state: ZoneEvaluationState,
  nextProposed: DemandLevel,
  consecutiveChecksRequired: number,
): ZoneEvaluationResult {
  const required = Math.max(1, Math.floor(consecutiveChecksRequired));
  const previousConfirmed = state.confirmed_demand_level;

  if (nextProposed === previousConfirmed) {
    return {
      proposed_demand_level: nextProposed,
      confirmed_demand_level: previousConfirmed,
      consecutive_match_count: 0,
      changed: false,
      previous_confirmed_demand_level: previousConfirmed,
    };
  }

  const count = state.proposed_demand_level === nextProposed ? state.consecutive_match_count + 1 : 1;

  if (count >= required) {
    return {
      proposed_demand_level: nextProposed,
      confirmed_demand_level: nextProposed,
      consecutive_match_count: 0,
      changed: true,
      previous_confirmed_demand_level: previousConfirmed,
    };
  }

  return {
    proposed_demand_level: nextProposed,
    confirmed_demand_level: previousConfirmed,
    consecutive_match_count: count,
    changed: false,
    previous_confirmed_demand_level: previousConfirmed,
  };
}

// ─── Open-trip eligibility ───

export const OPEN_TRIP_DEMAND_STATUSES = [
  'pending',
  'broadcasting',
  'searching',
  'searching_new_driver',
  'offered',
  'offering',
  'negotiating',
  'driver_notified',
  'awaiting_driver_response',
] as const;

export interface DemandTripCandidate {
  trip_id: string;
  status: string;
  driver_id: string | null;
  created_at: string | number | Date;
}

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

// ─── Zone-based surge resolution ───

export interface SurgeZone {
  id: string;
  service_area_id: string | null;
  active: boolean;
  source: 'manual' | 'computed';
  center_lat: number;
  center_lng: number;
  radius_meters: number;
  confirmed_demand_level: DemandLevel;
}

export interface SurgeResolution {
  zone_id: string | null;
  confirmed_demand_level: DemandLevel | null;
  applied_multiplier: number;
  surge_enabled: boolean;
  reason: 'NO_ZONE' | 'SURGE_DISABLED' | 'ZONE_MULTIPLIER' | 'NO_SETTINGS';
}

const EARTH_RADIUS_M = 6_371_000;

export function metersBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function findPickupZone(
  zones: SurgeZone[],
  pickupLat: number,
  pickupLng: number,
  serviceAreaId: string,
): SurgeZone | null {
  let best: { zone: SurgeZone; distance: number } | null = null;
  for (const z of zones) {
    if (!z.active) continue;
    // Only computed zones are eligible for pricing. Manual zones stay advisory.
    if (z.source !== 'computed') continue;
    if (z.service_area_id !== serviceAreaId) continue;
    const d = metersBetween(pickupLat, pickupLng, z.center_lat, z.center_lng);
    if (d > z.radius_meters) continue;
    if (!best || d < best.distance) best = { zone: z, distance: d };
  }
  return best?.zone ?? null;
}

export function multiplierForLevel(
  s: Pick<DemandZoneSettings, 'multiplier_low' | 'multiplier_medium' | 'multiplier_high' | 'max_multiplier'>,
  level: DemandLevel,
): number {
  const raw = level === 'HIGH' ? s.multiplier_high : level === 'MEDIUM' ? s.multiplier_medium : s.multiplier_low;
  if (raw == null || !Number.isFinite(raw) || raw < 1) return 1;
  return Math.min(raw, s.max_multiplier ?? raw);
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

// ─── Quote shape + lock ───

export interface SurgeQuote {
  quote_id: string;
  service_area_id: string;
  zone_id: string | null;
  confirmed_demand_level: DemandLevel | null;
  base_fare_before_surge_pence: number;
  applied_multiplier: number;
  surge_amount_pence: number;
  final_fare_pence: number;
  pickup_lat: number;
  pickup_lng: number;
  quote_expires_at: string;
}

export function buildSurgeQuote(params: {
  quoteId: string;
  serviceAreaId: string;
  baseFarePence: number;
  resolution: SurgeResolution;
  pickupLat: number;
  pickupLng: number;
  issuedAtMs: number;
  ttlSeconds?: number;
}): SurgeQuote {
  const multiplier = params.resolution.applied_multiplier;
  const final = Math.round(params.baseFarePence * multiplier);
  return {
    quote_id: params.quoteId,
    service_area_id: params.serviceAreaId,
    zone_id: params.resolution.zone_id,
    confirmed_demand_level: params.resolution.confirmed_demand_level,
    base_fare_before_surge_pence: params.baseFarePence,
    applied_multiplier: multiplier,
    surge_amount_pence: final - params.baseFarePence,
    final_fare_pence: final,
    pickup_lat: params.pickupLat,
    pickup_lng: params.pickupLng,
    quote_expires_at: new Date(params.issuedAtMs + (params.ttlSeconds ?? 300) * 1000).toISOString(),
  };
}

/** Map `resolve_zone_surge` RPC jsonb into the SSOT resolution shape. */
export function parseRpcSurgeResolution(data: unknown): SurgeResolution {
  const row = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  const level = String(row.confirmed_demand_level ?? '').toUpperCase();
  const confirmed =
    level === 'HIGH' || level === 'MEDIUM' || level === 'LOW'
      ? (level as DemandLevel)
      : null;
  return {
    zone_id: typeof row.zone_id === 'string' ? row.zone_id : null,
    confirmed_demand_level: confirmed,
    applied_multiplier: Number(row.applied_multiplier ?? 1),
    surge_enabled: row.surge_enabled === true,
    reason: (typeof row.reason === 'string' ? row.reason : 'NO_ZONE') as SurgeResolution['reason'],
  };
}

/** Zone surge applies to metered trip fare only — never route-fixed or airport add-ons. */
export function meteredFareEligibleForZoneSurge(
  fareSource: string,
  pricingMode: string,
): boolean {
  if (pricingMode === 'ROUTE_PRICING') return false;
  return fareSource === 'standard_dynamic';
}

export function applyZoneSurgeToMeteredFarePence(params: {
  tripFarePence: number;
  airportChargePence: number;
  surgeResolution: SurgeResolution;
  serviceAreaId: string;
  pickupLat: number;
  pickupLng: number;
  issuedAtMs: number;
}): {
  finalFarePence: number;
  surgeQuote: SurgeQuote;
  appliedMultiplier: number;
} {
  const surgeApplies = params.surgeResolution.surge_enabled
    && params.surgeResolution.applied_multiplier > 1;
  const surgeQuote = buildSurgeQuote({
    quoteId: crypto.randomUUID(),
    serviceAreaId: params.serviceAreaId,
    baseFarePence: params.tripFarePence,
    resolution: surgeApplies
      ? params.surgeResolution
      : { ...params.surgeResolution, applied_multiplier: 1 },
    pickupLat: params.pickupLat,
    pickupLng: params.pickupLng,
    issuedAtMs: params.issuedAtMs,
  });
  const finalFarePence = surgeQuote.final_fare_pence + params.airportChargePence;
  return {
    finalFarePence,
    surgeQuote,
    appliedMultiplier: surgeQuote.applied_multiplier,
  };
}

export type BookingSurgeQuoteInput = Pick<
  SurgeQuote,
  | 'quote_id'
  | 'service_area_id'
  | 'zone_id'
  | 'confirmed_demand_level'
  | 'applied_multiplier'
  | 'quote_expires_at'
  | 'pickup_lat'
  | 'pickup_lng'
>;

export function validateBookingSurgeQuote(
  quote: BookingSurgeQuoteInput | null | undefined,
  serverMultiplier: number,
  nowMs = Date.now(),
): { ok: true; multiplier: number } | { ok: false; code: string; message: string } {
  if (!quote || quote.applied_multiplier == null) {
    return { ok: true, multiplier: 1 };
  }
  const quoted = Number(quote.applied_multiplier);
  if (!Number.isFinite(quoted) || quoted < 1) {
    return {
      ok: false,
      code: 'SURGE_QUOTE_INVALID',
      message: 'Invalid demand surge quote. Please refresh your fare.',
    };
  }
  if (quote.quote_expires_at && new Date(quote.quote_expires_at).getTime() <= nowMs) {
    return {
      ok: false,
      code: 'SURGE_QUOTE_EXPIRED',
      message: 'Your fare quote expired. Please refresh and try again.',
    };
  }
  if (Math.abs(serverMultiplier - quoted) > 0.01) {
    return {
      ok: false,
      code: 'SURGE_QUOTE_STALE',
      message: 'Demand in this area changed. Please refresh your fare.',
    };
  }
  return { ok: true, multiplier: quoted };
}

/** Re-resolve pickup surge at booking time; never trust client multiplier alone. */
export async function assertBookingSurgeAtPickup(
  supabase: { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }> },
  params: {
    serviceAreaId: string;
    pickupLat: number;
    pickupLng: number;
    surgeQuote?: BookingSurgeQuoteInput | null;
  },
): Promise<{ ok: true; multiplier: number } | { ok: false; code: string; message: string }> {
  if (!params.surgeQuote?.applied_multiplier) {
    return { ok: true, multiplier: 1 };
  }
  const { data, error } = await supabase.rpc('resolve_zone_surge', {
    _service_area_id: params.serviceAreaId,
    _pickup_lat: params.pickupLat,
    _pickup_lng: params.pickupLng,
  });
  if (error) {
    return {
      ok: false,
      code: 'SURGE_RESOLUTION_FAILED',
      message: 'Unable to confirm demand pricing right now. Please try again.',
    };
  }
  const resolution = parseRpcSurgeResolution(data);
  return validateBookingSurgeQuote(
    params.surgeQuote,
    resolution.applied_multiplier,
  );
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

// ─── Permissions + admin mode ───

export const DEMAND_ZONE_ACTION_KEYS = {
  view: 'demand_zones.view',
  recompute: 'demand_zones.recompute',
  configureHeatMap: 'demand_zones.configure_heatmap',
  configureColours: 'demand_zones.configure_colours',
  configureSurge: 'demand_zones.configure_surge',
  viewAudit: 'demand_zones.view_audit',
} as const;

export type DemandZoneActionKey = (typeof DEMAND_ZONE_ACTION_KEYS)[keyof typeof DEMAND_ZONE_ACTION_KEYS];

export const ALL_SERVICE_AREAS = 'all';

export const ALL_SERVICE_AREAS_MESSAGE =
  'Select one service area to configure heat-map and surge settings.';

export function canConfigureForSelection(params: {
  selectedServiceAreaId: string;
  isSuperAdmin: boolean;
  allowedActions: string[];
  actionKey: DemandZoneActionKey;
}): boolean {
  if (params.selectedServiceAreaId === ALL_SERVICE_AREAS || !params.selectedServiceAreaId) return false;
  if (params.isSuperAdmin) return true;
  return params.allowedActions.includes(params.actionKey);
}
