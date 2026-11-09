/**
 * Geofence & Zone Pricing rules (`zone_pricing_rules`) applied once per trip.
 *
 * Applies To `both` ("Pickup & Dropoff") = either endpoint may match; each
 * matching rule is applied at most once (never twice for intra-zone trips).
 *
 * Flat Rate Addition is layered on top of meter or zone_route fixed fare.
 * Rule min/max floor/cap the ride+addition subtotal before airport charges.
 */

export type ZonePricingRuleRow = {
  id: string;
  zone_id: string;
  vehicle_type_id?: string | null;
  rule_type: string;
  value: number | null;
  min_fare?: number | null;
  max_fare?: number | null;
  applies_to: string;
  time_restrictions?: {
    days?: number[];
    start_time?: string;
    end_time?: string;
  } | null;
  is_active: boolean;
};

export type ZonePricingAdjustment = {
  /** Sum of matching flat_rate values (money units), each rule once. */
  flatAddition: number;
  /** Highest matching rule min_fare (money units); 0 if none. */
  minFare: number;
  /** Lowest matching rule max_fare (money units); null if none. */
  maxFare: number | null;
  /** Rule ids that contributed (deduped). */
  appliedRuleIds: string[];
  /** Human labels for fare_details / diagnostics. */
  detailLabels: string[];
};

export const ZONE_PRICING_RULES_QUOTE_SELECT =
  "id, zone_id, vehicle_type_id, rule_type, value, min_fare, max_fare, applies_to, time_restrictions, is_active";

function parseHmToMinutes(hm: string | null | undefined): number | null {
  if (!hm || typeof hm !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h < 0 || h > 23 || min < 0 || min > 59) {
    return null;
  }
  return h * 60 + min;
}

export function zonePricingRuleMatchesTime(
  restrictions: ZonePricingRuleRow["time_restrictions"],
  now: Date = new Date(),
): boolean {
  if (!restrictions || typeof restrictions !== "object") return true;
  const days = Array.isArray(restrictions.days) ? restrictions.days : null;
  if (days && days.length > 0) {
    const dow = now.getDay(); // 0=Sun
    if (!days.map(Number).includes(dow)) return false;
  }
  const start = parseHmToMinutes(restrictions.start_time);
  const end = parseHmToMinutes(restrictions.end_time);
  if (start == null || end == null) return true;
  const mins = now.getHours() * 60 + now.getMinutes();
  if (start <= end) return mins >= start && mins <= end;
  // Overnight window (e.g. 22:00–06:00)
  return mins >= start || mins <= end;
}

export function zonePricingRuleMatchesAppliesTo(
  appliesTo: string,
  zoneId: string,
  pickupZoneIds: ReadonlySet<string>,
  dropoffZoneIds: ReadonlySet<string>,
): boolean {
  const inPickup = pickupZoneIds.has(zoneId);
  const inDropoff = dropoffZoneIds.has(zoneId);
  const scope = String(appliesTo ?? "both").toLowerCase().trim();
  if (scope === "pickup") return inPickup;
  if (scope === "dropoff") return inDropoff;
  // both / Pickup & Dropoff → either endpoint (once per rule)
  return inPickup || inDropoff;
}

/**
 * Select matching active rules (vehicle + time + applies_to), each id once.
 * Only `flat_rate` contributes to flatAddition; min/max from all matching types.
 */
export function resolveZonePricingAdjustment(input: {
  rules: ZonePricingRuleRow[] | null | undefined;
  pickupZoneIds: ReadonlySet<string> | string[];
  dropoffZoneIds: ReadonlySet<string> | string[];
  vehicleTypeId?: string | null;
  now?: Date;
}): ZonePricingAdjustment {
  const pickup =
    input.pickupZoneIds instanceof Set
      ? input.pickupZoneIds
      : new Set(input.pickupZoneIds);
  const dropoff =
    input.dropoffZoneIds instanceof Set
      ? input.dropoffZoneIds
      : new Set(input.dropoffZoneIds);
  const now = input.now ?? new Date();
  const vt = input.vehicleTypeId ?? null;

  const seen = new Set<string>();
  let flatAddition = 0;
  let minFare = 0;
  let maxFare: number | null = null;
  const appliedRuleIds: string[] = [];
  const detailLabels: string[] = [];

  for (const rule of input.rules ?? []) {
    if (!rule || rule.is_active === false) continue;
    if (seen.has(rule.id)) continue;
    if (rule.vehicle_type_id && vt && rule.vehicle_type_id !== vt) continue;
    if (rule.vehicle_type_id && !vt) continue;
    if (!zonePricingRuleMatchesTime(rule.time_restrictions, now)) continue;
    if (
      !zonePricingRuleMatchesAppliesTo(
        rule.applies_to,
        rule.zone_id,
        pickup,
        dropoff,
      )
    ) {
      continue;
    }

    seen.add(rule.id);
    appliedRuleIds.push(rule.id);

    const type = String(rule.rule_type ?? "").toLowerCase().trim();
    const value = Number(rule.value);
    if (type === "flat_rate" && Number.isFinite(value) && value !== 0) {
      flatAddition += value;
      detailLabels.push(`Zone flat addition +£${value.toFixed(2)}`);
    }

    const ruleMin = Number(rule.min_fare);
    if (Number.isFinite(ruleMin) && ruleMin > 0) {
      minFare = Math.max(minFare, ruleMin);
    }
    const ruleMax = Number(rule.max_fare);
    if (Number.isFinite(ruleMax) && ruleMax > 0) {
      maxFare = maxFare == null ? ruleMax : Math.min(maxFare, ruleMax);
    }
  }

  return {
    flatAddition: Math.round(flatAddition * 100) / 100,
    minFare: Math.round(minFare * 100) / 100,
    maxFare: maxFare == null ? null : Math.round(maxFare * 100) / 100,
    appliedRuleIds,
    detailLabels,
  };
}

/**
 * Apply flat addition + rule min/max onto a ride fare (meter OR fixed route).
 *
 * Order (both meter and zone_route fixed):
 *   1) rideFare (meter subtotal / min fare OR fixed route fare)
 *   2) + matching flat_rate additions (each rule once)
 *   3) floor/cap by matching rule min_fare / max_fare
 *   4) caller adds airport → final_fare (do not add surcharge again)
 *
 * min_fare / max_fare: NULL or ≤0 means no floor/cap. Explicit 0 is a no-op floor.
 * Returns trip_fare (includes addition) and surcharge (flat only, for display).
 */
export function applyZonePricingToRideFare(input: {
  rideFare: number;
  adjustment: ZonePricingAdjustment;
}): { tripFare: number; surcharge: number; minimumRaised: boolean } {
  const ride = Number.isFinite(input.rideFare) ? input.rideFare : 0;
  const flat = Math.max(0, input.adjustment.flatAddition);
  let combined = ride + flat;
  let minimumRaised = false;
  // Explicit 0 / NULL / NaN → no floor (NULL vs 0 both no-ops; only >0 raises).
  if (input.adjustment.minFare > 0 && combined < input.adjustment.minFare) {
    combined = input.adjustment.minFare;
    minimumRaised = true;
  }
  if (
    input.adjustment.maxFare != null &&
    input.adjustment.maxFare > 0 &&
    combined > input.adjustment.maxFare
  ) {
    combined = input.adjustment.maxFare;
  }
  const tripFare = Math.round(combined * 100) / 100;
  const surcharge = Math.round(flat * 100) / 100;
  return { tripFare, surcharge, minimumRaised };
}
